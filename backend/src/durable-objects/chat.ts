import { DurableObject } from 'cloudflare:workers'

import type { Message, MessagePage } from '../protocol'

const PAGE = 50

/** One per chat (DM or group): the single source of truth and total order for its messages. */
export class ChatDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', read_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS message (seq INTEGER PRIMARY KEY, cid TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
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

  /** Stores a message once per `cid`, then fans it out to every member's UserDO. */
  send(uid: string, cid: string, body: string): Message {
    const members = this.members(uid)
    if (!members) throw new Error('Not a member of this chat')

    // A DO runs one request at a time, so max(seq) + 1 is a gap-free counter without locks.
    const inserted = this.sql
      .exec<{ seq: number; ts: number }>(
        `INSERT INTO message (seq, cid, sender, body, ts)
         SELECT coalesce(max(seq), 0) + 1, ?, ?, ?, ? FROM message WHERE true
         ON CONFLICT (cid) DO NOTHING RETURNING seq, ts`,
        cid,
        uid,
        body,
        Date.now()
      )
      .toArray()[0]
    // A retry of a stored message: ack it again without a second fan-out.
    if (!inserted) return this.sql.exec<Message>('SELECT ?1 AS chat, * FROM message WHERE cid = ?2', this.id, cid).one()

    const msg: Message = { chat: this.id, seq: inserted.seq, cid, sender: uid, body, ts: inserted.ts }
    // ponytail: fans out to every member on each send; cap groups near 256 members, or batch by region if they grow.
    this.ctx.waitUntil(
      Promise.allSettled(
        members.map((m) =>
          this.env.USER.get(this.env.USER.idFromName(m)).deliver(msg, members.find((p) => p !== m) ?? m)
        )
      )
    )
    return msg
  }

  /** The latest page, or the page before `before` when scrolling back through history. */
  messages(uid: string, before = Number.MAX_SAFE_INTEGER): MessagePage | null {
    if (!this.members(uid)) return null
    const messages = this.sql
      .exec<Message>(
        'SELECT ?1 AS chat, * FROM message WHERE seq < ?2 ORDER BY seq DESC LIMIT ?3',
        this.id,
        before,
        PAGE + 1
      )
      .toArray()
    const hasOlder = messages.length > PAGE
    if (hasOlder) messages.pop()
    return { messages: messages.reverse(), hasOlder }
  }
}
