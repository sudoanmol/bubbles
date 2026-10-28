import { DurableObject } from 'cloudflare:workers'

import { applyPatch, type ClientFrame, type Message } from '../protocol'

const PAGE = 50

type Row = Omit<Message, 'chat' | 'reply' | 'deleted' | 'reactions'> & {
  reply: string | null
  deleted: number
  reactions: string
}

/** One per chat (DM or group): the single source of truth and total order for its log. */
export class ChatDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    // The phase 1 `message` table is dropped, not migrated: there is no data worth keeping yet.
    this.sql.exec(`
      DROP TABLE IF EXISTS message;
      CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', read_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS event (
        seq INTEGER PRIMARY KEY, cid TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, reply TEXT, target INTEGER, edited INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL DEFAULT '{}', rev INTEGER NOT NULL
      );
    `)
  }

  get id() {
    return this.ctx.id.name!
  }

  /** Idempotent: adds any missing members. */
  init(members: string[]) {
    for (const m of members) this.sql.exec('INSERT OR IGNORE INTO member (user_id) VALUES (?)', m)
  }

  members(uid: string) {
    const ids = this.sql
      .exec<{ user_id: string }>('SELECT user_id FROM member')
      .toArray()
      .map((r) => r.user_id)
    return ids.includes(uid) ? ids : null
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
   * an edit, delete or reaction updates the message in place and adds a patch entry carrying its new state.
   */
  write(uid: string, f: ClientFrame): Message {
    const members = this.members(uid)
    if (!members) throw new Error('Not a member of this chat')
    // A retry of a stored frame: ack it again without a second fan-out.
    const [stored] = this.read('cid = ?', f.cid)
    if (stored) return stored

    // A DO runs one request at a time and this method never awaits, so max(seq) + 1 is a gap-free counter.
    const seq = this.sql.exec<{ seq: number }>('SELECT coalesce(max(seq), 0) + 1 AS seq FROM event').one().seq
    const base = { chat: this.id, seq, cid: f.cid, sender: uid, ts: Date.now(), rev: seq }
    let msg: Message
    if (f.t === 'send') {
      const [quoted] = f.reply ? this.read("seq = ? AND kind = 'text' AND deleted = 0", f.reply) : []
      if (f.reply && !quoted) throw new Error('That message is gone')
      const reply = quoted ? { seq: quoted.seq, sender: quoted.sender, body: quoted.body.slice(0, 200) } : null
      msg = { ...base, kind: 'text', body: f.body, reply, target: null, edited: null, deleted: false, reactions: {} }
    } else {
      const [target] = this.read("seq = ? AND kind = 'text'", f.seq)
      if (!target) throw new Error('That message is gone')
      const next = applyPatch(target, f, uid, base.ts)
      if (typeof next === 'string') throw new Error(next)
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

    // ponytail: fans out to every member on each write; cap groups near 256 members, or batch by region if they grow.
    this.ctx.waitUntil(
      Promise.allSettled(
        members.map((m) =>
          this.env.USER.get(this.env.USER.idFromName(m)).deliver(msg, members.find((p) => p !== m) ?? m)
        )
      )
    )
    return msg
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
