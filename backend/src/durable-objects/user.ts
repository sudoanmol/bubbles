import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'

import { ClientFrame, type InboxItem, type Message, type ServerFrame } from '../protocol'

export type InboxRow = {
  chat_id: string
  peer_id: string
  last_seq: number
  /** JSON of InboxItem['preview']. */
  preview: string | null
  updated_at: number
}

/** One per user: holds every socket the user has open and their inbox. */
export class UserDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    this.sql.exec(`
      DROP TABLE IF EXISTS inbox;
      CREATE TABLE IF NOT EXISTS chat (
        chat_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, preview TEXT,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  get uid() {
    return this.ctx.id.name!
  }

  /** Accepts a hibernating WebSocket; the Worker has already authenticated the user. */
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // Frames from a socket are handled one at a time, so a burst (an outbox replay) keeps its order in the chat.
  // ponytail: one queue per user across all chats; per-chat queues if one slow chat ever holds up the others.
  queue = Promise.resolve()

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    this.queue = this.queue.then(() => this.handle(ws, data)).catch((error) => console.error(error))
    return this.queue
  }

  async handle(ws: WebSocket, data: string | ArrayBuffer) {
    let frame: ClientFrame
    try {
      frame = v.parse(ClientFrame, JSON.parse(data as string))
    } catch {
      return send(ws, { t: 'error', message: 'Invalid frame' })
    }
    try {
      const msg = await this.env.CHAT.get(this.env.CHAT.idFromName(frame.chat)).write(this.uid, frame)
      send(ws, { t: 'ack', msg })
    } catch (error) {
      send(ws, { t: 'error', cid: frame.cid, message: error instanceof Error ? error.message : 'Send failed' })
    }
  }

  /** Called by ChatDO for each new log entry; idempotent per (chat, seq). */
  deliver(msg: Message, peer: string) {
    const row = this.sql.exec<InboxRow>('SELECT * FROM chat WHERE chat_id = ?', msg.chat).toArray()[0]
    const current: InboxItem['preview'] = row?.preview ? JSON.parse(row.preview) : null
    // A new message becomes the preview; a change to the message that is the preview updates it.
    const preview: InboxItem['preview'] =
      msg.kind === 'text'
        ? { seq: msg.seq, sender: msg.sender, body: msg.body, deleted: false }
        : current?.seq === msg.target
          ? { ...current, body: msg.body, deleted: msg.deleted }
          : current
    if (!row || msg.seq > row.last_seq)
      this.sql.exec(
        `INSERT INTO chat (chat_id, peer_id, last_seq, preview, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (chat_id) DO UPDATE SET last_seq = ?3, preview = ?4, updated_at = ?5`,
        msg.chat,
        peer,
        msg.seq,
        preview && JSON.stringify(preview),
        msg.kind === 'text' ? msg.ts : (row?.updated_at ?? msg.ts)
      )
    const frame = JSON.stringify({ t: 'msg', msg } satisfies ServerFrame)
    for (const ws of this.ctx.getWebSockets()) ws.send(frame)
  }

  /** Adds a chat the user opened before anyone has written in it. */
  open(chat: string, peer: string) {
    this.sql.exec('INSERT OR IGNORE INTO chat (chat_id, peer_id, updated_at) VALUES (?, ?, ?)', chat, peer, Date.now())
  }

  inbox() {
    return this.sql.exec<InboxRow>('SELECT * FROM chat ORDER BY updated_at DESC').toArray()
  }
}

function send(ws: WebSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame))
}
