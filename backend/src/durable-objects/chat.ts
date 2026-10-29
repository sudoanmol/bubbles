import { DurableObject } from 'cloudflare:workers'

import {
  applyPatch,
  firstLink,
  MAX_MEMBERS,
  previewText,
  type Ephemeral,
  type GroupEvent,
  type Message,
  type MessageState,
  type Person,
  type Read,
  type Refused,
  type Role,
  type ServerFrame,
  type System,
  type Write,
} from '../protocol'
import { unfurl } from '../unfurl'
import { migrate } from './schema'

const PAGE = 50

/** How long until fan-out is tried again after this object stopped partway, or after a first failure. */
const RETRY_MS = 5_000

/** The longest wait between retries while a member stays unreachable. */
const MAX_RETRY_MS = 5 * 60_000

type Row = Omit<Message, 'chat' | 'reply' | 'deleted' | 'reactions' | 'images' | 'link' | 'kind' | 'target'> &
  ({ kind: 'text' | 'system'; target: null } | { kind: 'patch'; target: number }) & {
    reply: string | null
    deleted: number
    reactions: string
    images: string
    link: string | null
  }

type MemberRow = {
  user_id: string
  role: Role
  read_seq: number
  read_ts: number
  joined: number
  /** The entry that took them out of the group (left, removed, deleted); they can read up to it. Null while in it. */
  left_seq: number | null
  /** Who did: themselves if they left. */
  left_by: string | null
}

/** A change to a group by one of its members, checked and applied by `manage`. Names come from the caller (D1). */
export type GroupOp =
  | { t: 'rename'; name: string }
  | { t: 'add'; users: Person[] }
  | { t: 'remove'; user: Person }
  | { t: 'admin'; user: Person; admin: boolean }
  | { t: 'leave'; successor?: Person }
  | { t: 'delete' }

/** One per chat (DM or group): the single source of truth and total order for its log. */
export class ChatDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    migrate(ctx.storage, [
      // The phase 1 `message` table was replaced by the log, not migrated.
      `DROP TABLE IF EXISTS message;
       CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', read_seq INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE IF NOT EXISTS event (
         seq INTEGER PRIMARY KEY, cid TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, ts INTEGER NOT NULL,
         kind TEXT NOT NULL, body TEXT NOT NULL, reply TEXT, target INTEGER, edited INTEGER,
         deleted INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL DEFAULT '{}', rev INTEGER NOT NULL
       );
       -- The last seq each member's UserDO has stored. Fan-out sends everything after it, so it survives failures.
       CREATE TABLE IF NOT EXISTS delivery (user_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);`,
      'ALTER TABLE member ADD COLUMN read_ts INTEGER NOT NULL DEFAULT 0;',
      `ALTER TABLE member ADD COLUMN joined INTEGER NOT NULL DEFAULT 0;
       ALTER TABLE member ADD COLUMN left_seq INTEGER;
       ALTER TABLE member ADD COLUMN left_by TEXT;`,
      `ALTER TABLE event ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
       ALTER TABLE event ADD COLUMN link TEXT;`,
    ])
  }

  /** Set for a group (absent for a DM): its name, and whether an admin deleted it. */
  get group() {
    return this.ctx.storage.kv.get<{ name: string; deleted: boolean }>('group')
  }

  get id() {
    return this.ctx.id.name!
  }

  /** Idempotent: adds any missing members. */
  init(members: string[]) {
    for (const m of members) this.sql.exec('INSERT OR IGNORE INTO member (user_id) VALUES (?)', m)
  }

  /** Every member, past ones included, or null if `uid` was never one. */
  members(uid: string) {
    const rows = this.sql.exec<MemberRow>('SELECT * FROM member ORDER BY joined, user_id').toArray()

    return rows.some((r) => r.user_id === uid) ? rows : null
  }

  /** The chat as `uid` may see it, or null if they were never in it. */
  info(uid: string) {
    const members = this.members(uid)

    return members && { group: this.group ?? null, members }
  }

  /** `uid`'s row while they're in the chat. */
  active(uid: string) {
    return this.sql.exec<MemberRow>('SELECT * FROM member WHERE user_id = ? AND left_seq IS NULL', uid).toArray()[0]
  }

  /** The seq the next entry gets. A DO runs one request at a time and nothing here awaits, so it's gap-free. */
  nextSeq() {
    return this.sql.exec<{ seq: number }>('SELECT coalesce(max(seq), 0) + 1 AS seq FROM event').one().seq
  }

  read(where: string, ...params: (string | number)[]) {
    return this.sql
      .exec<Row>(`SELECT * FROM event WHERE ${where}`, ...params)
      .toArray()
      .map((r): Message => ({
        ...r,
        chat: this.id,
        reply: r.reply === null ? null : JSON.parse(r.reply),
        deleted: r.deleted === 1,
        reactions: JSON.parse(r.reactions),
        images: JSON.parse(r.images),
        link: r.link === null ? null : JSON.parse(r.link),
      }))
  }

  /**
   * Appends a frame to the log once per `cid` and fans the entry out to every member's UserDO. A send adds a message;
   * an edit, delete or reaction updates the message in place and adds a patch entry carrying its new state. A refusal
   * is returned, not thrown, so the caller can tell it from a failure to reach this object.
   */
  write(uid: string, f: Write): Message | Refused {
    if (!this.active(uid)) return { refused: 'Not a member of this chat' }
    // A retry of a stored frame: ack it again without a second fan-out.
    const [stored] = this.read('cid = ?', f.cid)

    if (stored) return stored

    const seq = this.nextSeq()
    const base = { chat: this.id, seq, cid: f.cid, sender: uid, ts: Date.now(), rev: seq }

    if (f.t === 'send') {
      const [quoted] = f.reply ? this.read("seq = ? AND kind = 'text' AND deleted = 0", f.reply) : []

      if (f.reply && !quoted) return { refused: 'That message is gone' }
      const reply = quoted ? { seq: quoted.seq, sender: quoted.sender, body: previewText(quoted).slice(0, 200) } : null

      const msg: Message = {
        ...base,
        kind: 'text',
        body: f.body,
        reply,
        target: null,
        edited: null,
        deleted: false,
        reactions: {},
        images: f.images ?? [],
        link: null,
      }

      // Writing in a chat means you've read it; others see "Read" from your reply without a separate receipt.
      this.sql.exec('UPDATE member SET read_seq = ?, read_ts = ? WHERE user_id = ?', seq, base.ts, uid)
      this.commit(msg)
      this.card(seq, msg)

      return msg
    }

    const [target] = this.read("seq = ? AND kind = 'text'", f.seq)

    if (!target) return { refused: 'That message is gone' }
    const next = applyPatch(target, f, uid, base.ts)

    if ('refused' in next) return next
    const msg = this.patch(target.seq, next, base)

    if (f.t === 'edit') this.card(target.seq, next)

    return msg
  }

  /** Updates the message at `target` in place and appends a patch entry with its new state. */
  patch(target: number, next: MessageState, base: Pick<Message, 'seq' | 'cid' | 'sender' | 'ts'>) {
    this.sql.exec(
      `UPDATE event SET body = ?, reply = ?, edited = ?, deleted = ?, reactions = ?, images = ?, link = ?, rev = ?
       WHERE seq = ?`,
      ...columns(next),
      base.seq,
      target
    )
    const msg: Message = { ...base, ...next, chat: this.id, rev: base.seq, kind: 'patch', target }
    this.commit(msg)

    return msg
  }

  /**
   * Fetches the card for the first link in the text of message `seq`, unless it has that card already, and adds it
   * with a patch, like an edit by its sender. Called after a send or an edit, the only writes that change the text, so
   * a reaction never refetches a page. Not awaited by the write: the message goes out at once and its card follows.
   * ponytail: lost if this object restarts while the page loads; the message then stays without a card.
   */
  card(seq: number, state: Pick<MessageState, 'body' | 'link'>) {
    const url = firstLink(state.body)

    if (!url || state.link?.url === url) return

    void unfurl(this.env, url)
      .then((link) => {
        const [m] = link ? this.read("seq = ? AND kind = 'text'", seq) : []

        // Edited or deleted while the page loaded, or a card came first.
        if (!m || m.deleted || firstLink(m.body) !== url || m.link?.url === url) return
        const { body, reply, edited, deleted, reactions, images } = m
        this.patch(
          seq,
          { body, reply, edited, deleted, reactions, images, link },
          { seq: this.nextSeq(), cid: crypto.randomUUID(), sender: m.sender, ts: Date.now() }
        )
      })
      .catch((error) => console.error('Unfurl failed', error))
  }

  /** Appends an entry and fans it out to every member's UserDO. */
  commit(msg: Message) {
    this.sql.exec(
      `INSERT INTO event (seq, cid, sender, ts, kind, target, rev, body, reply, edited, deleted, reactions, images, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.seq,
      msg.cid,
      msg.sender,
      msg.ts,
      msg.kind,
      msg.target,
      msg.rev,
      ...columns(msg)
    )

    // Members delivered up to the previous entry; someone new starts here rather than being sent the whole history.
    this.sql.exec('INSERT OR IGNORE INTO delivery (user_id, seq) SELECT user_id, ? FROM member', msg.seq - 1)
    // Stored with the entry, so a fan-out cut short by an eviction or a deploy still finishes.
    void this.ctx.storage.setAlarm(Date.now() + RETRY_MS)
    void this.fanOut()
  }

  /** Appends a group event by `uid`. */
  system(uid: string, e: GroupEvent): System {
    const seq = this.nextSeq()

    const msg: System = {
      chat: this.id,
      seq,
      cid: crypto.randomUUID(),
      sender: uid,
      ts: Date.now(),
      rev: seq,
      kind: 'system',
      body: JSON.stringify(e),
      reply: null,
      target: null,
      edited: null,
      deleted: false,
      reactions: {},
      images: [],
      link: null,
    }

    this.commit(msg)

    return msg
  }

  /** Starts a group: `people` are its first members, `uid` (one of them) its admin. */
  create(uid: string, name: string, people: Person[]) {
    const now = Date.now()
    this.ctx.storage.kv.put('group', { name, deleted: false })

    for (const p of people)
      this.sql.exec(
        'INSERT OR IGNORE INTO member (user_id, role, joined) VALUES (?, ?, ?)',
        p.id,
        p.id === uid ? 'admin' : 'member',
        now
      )
    const by = people.find((p) => p.id === uid)!
    this.system(uid, { t: 'created', by, name })
    const others = people.filter((p) => p.id !== uid)

    if (others.length) this.system(uid, { t: 'added', by, users: others, name })
  }

  /**
   * Applies a change to the group by `uid` (`by` is them, with their name) and logs it. Anyone in it can rename it or
   * leave; only admins add, remove, promote and delete. The only admin hands over to `successor` as they leave, so a
   * group with members always has an admin. Someone out of the group stops receiving it at the entry that took them
   * out, which they do receive.
   */
  manage(uid: string, by: Person, op: GroupOp): System[] | Refused {
    const group = this.group
    const me = this.active(uid)

    if (!group || !me) return { refused: 'Not in this group' }
    const actives = this.sql.exec<MemberRow>('SELECT * FROM member WHERE left_seq IS NULL').toArray()
    const isActive = (id: string) => actives.some((a) => a.user_id === id)

    if (op.t === 'rename') {
      this.ctx.storage.kv.put('group', { ...group, name: op.name })

      return [this.system(uid, { t: 'renamed', by, name: op.name })]
    }

    if (op.t === 'leave') {
      const out: System[] = []
      const others = actives.filter((a) => a.user_id !== uid)

      if (me.role === 'admin' && others.length && !others.some((a) => a.role === 'admin')) {
        if (!op.successor || !isActive(op.successor.id) || op.successor.id === uid)
          return { refused: 'Choose a new admin first' }
        this.sql.exec("UPDATE member SET role = 'admin' WHERE user_id = ?", op.successor.id)
        out.push(this.system(uid, { t: 'admin', by, user: op.successor, admin: true }))
      }

      this.leave(uid, uid)
      out.push(this.system(uid, { t: 'left', by }))

      return out
    }

    if (me.role !== 'admin') return { refused: 'Only admins can do that' }

    switch (op.t) {
      case 'add': {
        const fresh = op.users.filter((u) => !isActive(u.id))

        if (!fresh.length) return { refused: 'Already in the group' }

        if (actives.length + fresh.length > MAX_MEMBERS) return { refused: `Groups hold up to ${MAX_MEMBERS} people` }
        const seq = this.nextSeq()

        for (const u of fresh) {
          // Someone added back starts from here, not from where they left.
          this.sql.exec(
            `INSERT INTO member (user_id, joined) VALUES (?1, ?2)
             ON CONFLICT (user_id) DO UPDATE SET role = 'member', joined = ?2, left_seq = NULL, left_by = NULL`,
            u.id,
            Date.now()
          )
          this.sql.exec('INSERT OR REPLACE INTO delivery (user_id, seq) VALUES (?, ?)', u.id, seq - 1)
        }

        return [this.system(uid, { t: 'added', by, users: fresh, name: group.name })]
      }

      case 'remove':
        if (op.user.id === uid || !isActive(op.user.id)) return { refused: 'Not in this group' }
        this.leave(op.user.id, uid)

        return [this.system(uid, { t: 'removed', by, user: op.user })]
      case 'admin':
        if (op.user.id === uid || !isActive(op.user.id)) return { refused: 'Not in this group' }
        this.sql.exec('UPDATE member SET role = ? WHERE user_id = ?', op.admin ? 'admin' : 'member', op.user.id)

        return [this.system(uid, { t: 'admin', by, user: op.user, admin: op.admin })]
      case 'delete':
        this.ctx.storage.kv.put('group', { ...group, deleted: true })

        for (const a of actives) this.leave(a.user_id, uid)

        return [this.system(uid, { t: 'deleted', by })]
    }
  }

  /** Takes `id` out of the group at the next entry (the one saying so), on `by`'s doing. */
  leave(id: string, by: string) {
    this.sql.exec('UPDATE member SET left_seq = ?, left_by = ? WHERE user_id = ?', this.nextSeq(), by, id)
  }

  /**
   * Marks the chat read up to `seq` (never backwards, never past the end) and tells the other members' devices. Returns
   * the reader's state for their own devices, so a retry after a lost answer gets the same reply.
   * ponytail: receipts to others aren't retried; a device that misses one catches up when it next loads the chat.
   */
  markRead(uid: string, seq: number): Extract<ServerFrame, { t: 'read' }> | null {
    const me = this.members(uid)?.find((m) => m.user_id === uid)

    if (!me) return null
    // Someone out of the group can read up to the entry that took them out.
    const end = me.left_seq ?? this.nextSeq() - 1
    let read: Read = { seq: me.read_seq, ts: me.read_ts }

    if (Math.min(seq, end) > read.seq) {
      read = { seq: Math.min(seq, end), ts: Date.now() }
      this.sql.exec('UPDATE member SET read_seq = ?, read_ts = ? WHERE user_id = ?', read.seq, read.ts, uid)
      this.relay(uid, { t: 'read', chat: this.id, uid, ...read })
    }

    const { unread } = this.sql
      .exec<{ unread: number }>(
        "SELECT count(*) AS unread FROM event WHERE kind = 'text' AND sender != ? AND seq > ? AND seq <= ?",
        uid,
        read.seq,
        end
      )
      .one()

    return { t: 'read', chat: this.id, uid, ...read, unread }
  }

  /** Tells the other members' devices that `uid` is typing. */
  typing(uid: string) {
    if (this.active(uid)) this.relay(uid, { t: 'typing', chat: this.id, uid })
  }

  /** Passes an ephemeral frame from `uid` to every other member's devices, once, without waiting. */
  relay(uid: string, frame: Ephemeral) {
    for (const m of this.members(uid) ?? [])
      if (m.user_id !== uid && m.left_seq === null)
        void this.env.USER.get(this.env.USER.idFromName(m.user_id))
          .push(frame)
          .catch((error) => console.error('Relay failed', error))
  }

  alarm() {
    return this.fanOut()
  }

  fanning = false
  again = false
  /** Fan-out passes in a row that failed; each doubles the wait before the next. Starts over if this object restarts. */
  failures = 0

  /**
   * Brings every member's UserDO up to the end of the log, in `seq` order, one pass at a time. A member that can't be
   * reached keeps its place and is tried again by the alarm; UserDO stores entries idempotently, so resending is safe.
   * ponytail: fans out to every member on each write; cap groups near 256 members, or batch by region if they grow.
   * ponytail: retries an unreachable member forever, backing off to MAX_RETRY_MS; give up after a while if that costs.
   */
  async fanOut() {
    if (this.fanning) return void (this.again = true)
    this.fanning = true

    try {
      for (;;) {
        this.again = false

        // Each member gets the log up to its end, or up to the entry that took them out of the group.
        const behind = this.sql
          .exec<{ user_id: string; seq: number; until: number }>(
            `SELECT user_id, d.seq, coalesce(m.left_seq, (SELECT max(seq) FROM event)) AS until
             FROM delivery d JOIN member m USING (user_id) WHERE d.seq < until`
          )
          .toArray()

        if (!behind.length) {
          if (this.again) continue
          void this.ctx.storage.deleteAlarm()

          return
        }

        const members = this.sql
          .exec<{ user_id: string }>('SELECT user_id FROM member')
          .toArray()
          .map((r) => r.user_id)

        const group = this.group !== undefined

        const results = await Promise.allSettled(
          behind.map(async ({ user_id, seq, until }) => {
            const entries = this.read('seq > ? AND seq <= ? ORDER BY seq LIMIT ?', seq, until, PAGE)
            await this.env.USER.get(this.env.USER.idFromName(user_id)).deliver(
              entries,
              group ? { kind: 'group' } : { kind: 'dm', peer: members.find((m) => m !== user_id) ?? user_id }
            )
            this.sql.exec(
              'UPDATE delivery SET seq = max(seq, ?) WHERE user_id = ?',
              entries[entries.length - 1].seq,
              user_id
            )
          })
        )

        const failed = results.filter((r) => r.status === 'rejected')

        if (failed.length) {
          console.error(
            'Fan-out failed; retrying',
            failed.map((r) => r.reason)
          )
          this.failures++
          void this.ctx.storage.setAlarm(Date.now() + Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS))

          return
        }

        this.failures = 0
      }
    } finally {
      this.fanning = false
    }
  }

  /**
   * Pages of the log in ascending `seq`. `after` returns what came after a client's cursor (gap repair); if the client
   * is more than a page behind it gets the latest page instead and drops its older copy. `before` scrolls back.
   */
  messages(uid: string, { before, after }: { before?: number; after?: number } = {}): Message[] | null {
    const me = this.members(uid)?.find((m) => m.user_id === uid)

    if (!me) return null
    // Someone out of the group keeps the history up to the entry that took them out, and nothing after it.
    const end = me.left_seq ?? Number.MAX_SAFE_INTEGER

    if (after !== undefined) {
      const newer = this.read('seq > ? AND seq <= ? ORDER BY seq LIMIT ?', after, end, PAGE + 1)

      if (newer.length <= PAGE) return newer
    }

    return this.read('seq < ? ORDER BY seq DESC LIMIT ?', Math.min(before ?? end + 1, end + 1), PAGE).reverse()
  }
}

const columns = (m: MessageState) =>
  [
    m.body,
    m.reply && JSON.stringify(m.reply),
    m.edited,
    m.deleted ? 1 : 0,
    JSON.stringify(m.reactions),
    JSON.stringify(m.images),
    m.link && JSON.stringify(m.link),
  ] as const
