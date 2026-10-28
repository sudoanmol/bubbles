import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'

import { ClientFrame, type Message, type ServerFrame } from '../protocol'

type InboxRow = {
  chat_id: string
  peer_id: string
  last_seq: number
  preview_sender: string | null
  preview_body: string | null
  updated_at: number
}

/** One per user: holds every socket the user has open and their inbox. */
export class UserDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        chat_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
        preview_sender TEXT, preview_body TEXT, updated_at INTEGER NOT NULL
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
    const { chat, cid, body } = frame
    try {
      const msg = await this.env.CHAT.get(this.env.CHAT.idFromName(chat)).send(this.uid, cid, body)
      send(ws, { t: 'ack', chat, cid, seq: msg.seq, ts: msg.ts })
    } catch (error) {
      send(ws, { t: 'error', cid, message: error instanceof Error ? error.message : 'Send failed' })
    }
  }

  /** Called by ChatDO for each new message; idempotent per (chat, seq). */
  deliver(msg: Message, peer: string) {
    this.sql.exec(
      `INSERT INTO inbox (chat_id, peer_id, last_seq, preview_sender, preview_body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (chat_id) DO UPDATE SET last_seq = ?3, preview_sender = ?4, preview_body = ?5, updated_at = ?6
       WHERE ?3 > last_seq`,
      msg.chat,
      peer,
      msg.seq,
      msg.sender,
      msg.body,
      msg.ts
    )
    const frame = JSON.stringify({ t: 'msg', msg } satisfies ServerFrame)
    for (const ws of this.ctx.getWebSockets()) ws.send(frame)
  }

  /** Adds a chat the user opened before anyone has written in it. */
  open(chat: string, peer: string) {
    this.sql.exec('INSERT OR IGNORE INTO inbox (chat_id, peer_id, updated_at) VALUES (?, ?, ?)', chat, peer, Date.now())
  }

  inbox() {
    return this.sql.exec<InboxRow>('SELECT * FROM inbox ORDER BY updated_at DESC').toArray()
  }
}

function send(ws: WebSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame))
}
