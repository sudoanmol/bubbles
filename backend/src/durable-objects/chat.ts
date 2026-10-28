import { DurableObject } from 'cloudflare:workers'

import { applyPatch, type Message, type Read, type ServerFrame, type Write } from '../protocol'
import { migrate } from './schema'

const PAGE = 50
/** How long until fan-out is tried again after this object stopped partway, or after a first failure. */
const RETRY_MS = 5_000
/** The longest wait between retries while a member stays unreachable. */
const MAX_RETRY_MS = 5 * 60_000

type Row = Omit<Message, 'chat' | 'reply' | 'deleted' | 'reactions' | 'kind' | 'target'> &
  ({ kind: 'text'; target: null } | { kind: 'patch'; target: number }) & {
    reply: string | null
    deleted: number
    reactions: string
  }

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
    ])
  }

  get id() {
    return this.ctx.id.name!
  }

  /** Idempotent: adds any missing members. */
  init(members: string[]) {
    for (const m of members) this.sql.exec('INSERT OR IGNORE INTO member (user_id) VALUES (?)', m)
  }

  /** Every member and how far they've read, or null if `uid` isn't one. */
  members(uid: string) {
    const rows = this.sql
      .exec<{ user_id: string; read_seq: number; read_ts: number }>('SELECT user_id, read_seq, read_ts FROM member')
      .toArray()
    return rows.some((r) => r.user_id === uid) ? rows : null
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
      }))
  }

  /**
   * Appends a frame to the log once per `cid` and fans the entry out to every member's UserDO. A send adds a message;
   * an edit, delete or reaction updates the message in place and adds a patch entry carrying its new state. A refusal
   * is returned, not thrown, so the caller can tell it from a failure to reach this object.
   */
  write(uid: string, f: Write): Message | { refused: string } {
    if (!this.members(uid)) return { refused: 'Not a member of this chat' }
    // A retry of a stored frame: ack it again without a second fan-out.
    const [stored] = this.read('cid = ?', f.cid)
    if (stored) return stored

    // A DO runs one request at a time and this method never awaits, so max(seq) + 1 is a gap-free counter.
    const seq = this.sql.exec<{ seq: number }>('SELECT coalesce(max(seq), 0) + 1 AS seq FROM event').one().seq
    const base = { chat: this.id, seq, cid: f.cid, sender: uid, ts: Date.now(), rev: seq }
    let msg: Message
    if (f.t === 'send') {
      const [quoted] = f.reply ? this.read("seq = ? AND kind = 'text' AND deleted = 0", f.reply) : []
      if (f.reply && !quoted) return { refused: 'That message is gone' }
      const reply = quoted ? { seq: quoted.seq, sender: quoted.sender, body: quoted.body.slice(0, 200) } : null
      msg = { ...base, kind: 'text', body: f.body, reply, target: null, edited: null, deleted: false, reactions: {} }
      // Writing in a chat means you've read it; others see "Read" from your reply without a separate receipt.
      this.sql.exec('UPDATE member SET read_seq = ?, read_ts = ? WHERE user_id = ?', seq, base.ts, uid)
    } else {
      const [target] = this.read("seq = ? AND kind = 'text'", f.seq)
      if (!target) return { refused: 'That message is gone' }
      const next = applyPatch(target, f, uid, base.ts)
      if (typeof next === 'string') return { refused: next }
      this.sql.exec(
        'UPDATE event SET body = ?, reply = ?, edited = ?, deleted = ?, reactions = ?, rev = ? WHERE seq = ?',
        ...columns(next),
        seq,
        target.seq
      )
      msg = { ...base, ...next, kind: 'patch', target: target.seq }
    }
    this.sql.exec(
      `INSERT INTO event (seq, cid, sender, ts, kind, target, rev, body, reply, edited, deleted, reactions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    this.sql.exec('INSERT OR IGNORE INTO delivery (user_id, seq) SELECT user_id, ? FROM member', seq - 1)
    // Stored with the entry, so a fan-out cut short by an eviction or a deploy still finishes.
    void this.ctx.storage.setAlarm(Date.now() + RETRY_MS)
    void this.fanOut()
    return msg
  }

  /**
   * Marks the chat read up to `seq` (never backwards, never past the end) and tells the other members' devices. Returns
   * the reader's state for their own devices, so a retry after a lost answer gets the same reply.
   * ponytail: receipts to others aren't retried; a device that misses one catches up when it next loads the chat.
   */
  markRead(uid: string, seq: number): Extract<ServerFrame, { t: 'read' }> | null {
    const me = this.members(uid)?.find((m) => m.user_id === uid)
    if (!me) return null
    const end = this.sql.exec<{ seq: number }>('SELECT coalesce(max(seq), 0) AS seq FROM event').one().seq
    let read: Read = { seq: me.read_seq, ts: me.read_ts }
    if (Math.min(seq, end) > read.seq) {
      read = { seq: Math.min(seq, end), ts: Date.now() }
      this.sql.exec('UPDATE member SET read_seq = ?, read_ts = ? WHERE user_id = ?', read.seq, read.ts, uid)
      const receipt = { t: 'read', chat: this.id, uid, ...read } as const
      for (const m of this.members(uid)!)
        if (m.user_id !== uid)
          void this.env.USER.get(this.env.USER.idFromName(m.user_id))
            .receipt(receipt)
            .catch((error) => console.error('Receipt failed', error))
    }
    const { unread } = this.sql
      .exec<{ unread: number }>(
        "SELECT count(*) AS unread FROM event WHERE kind = 'text' AND sender != ? AND seq > ?",
        uid,
        read.seq
      )
      .one()
    return { t: 'read', chat: this.id, uid, ...read, unread }
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
        const behind = this.sql
          .exec<{ user_id: string; seq: number }>(
            'SELECT user_id, seq FROM delivery JOIN member USING (user_id) WHERE seq < (SELECT max(seq) FROM event)'
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
        const results = await Promise.allSettled(
          behind.map(async ({ user_id, seq }) => {
            const entries = this.read('seq > ? ORDER BY seq LIMIT ?', seq, PAGE)
            await this.env.USER.get(this.env.USER.idFromName(user_id)).deliver(
              entries,
              members.find((m) => m !== user_id) ?? user_id
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
    if (!this.members(uid)) return null
    if (after !== undefined) {
      const newer = this.read('seq > ? ORDER BY seq LIMIT ?', after, PAGE + 1)
      if (newer.length <= PAGE) return newer
    }
    return this.read('seq < ? ORDER BY seq DESC LIMIT ?', before ?? Number.MAX_SAFE_INTEGER, PAGE).reverse()
  }
}

const columns = (m: Pick<Message, 'body' | 'reply' | 'edited' | 'deleted' | 'reactions'>) =>
  [m.body, m.reply && JSON.stringify(m.reply), m.edited, m.deleted ? 1 : 0, JSON.stringify(m.reactions)] as const
