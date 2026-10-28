import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'

import { ClientFrame, nextPreview, nextRead, type Message, type Preview, type ServerFrame } from '../protocol'
import { migrate } from './schema'

export type InboxRow = {
  chat_id: string
  peer_id: string
  last_seq: number
  /** JSON of a Preview. */
  preview: string | null
  updated_at: number
  read_seq: number
  /** Messages from others after `read_seq`. */
  unread: number
}

/** One per user: holds every socket the user has open and their inbox. */
export class UserDO extends DurableObject<CloudflareBindings> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    migrate(ctx.storage, [
      // The phase 1 `inbox` table was replaced by `chat`, not migrated.
      `DROP TABLE IF EXISTS inbox;
       CREATE TABLE IF NOT EXISTS chat (
         chat_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, preview TEXT,
         updated_at INTEGER NOT NULL
       );`,
      `ALTER TABLE chat ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
       ALTER TABLE chat ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;`,
    ])
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
    // Closed after a failure below: its later frames must not overtake the failed one, and come again on reconnect.
    if (ws.readyState !== WebSocket.OPEN) return
    let frame: ClientFrame
    try {
      frame = v.parse(ClientFrame, JSON.parse(data as string))
    } catch {
      return send(ws, { t: 'error', message: 'Invalid frame' })
    }
    if (frame.t === 'read') return this.read(frame.chat, frame.seq)
    let result: Message | { refused: string }
    try {
      result = await this.env.CHAT.get(this.env.CHAT.idFromName(frame.chat)).write(this.uid, frame)
    } catch (error) {
      // The chat was unreachable, or whether the write landed is unknown. Not a refusal: the client reconnects and
      // replays its outbox in order with the same cids, and the chat dedupes anything that did land.
      console.error(error)
      return ws.close(1011, 'Try again')
    }
    send(ws, 'refused' in result ? { t: 'error', cid: frame.cid, message: result.refused } : { t: 'ack', msg: result })
  }

  /**
   * Marks a chat read and brings every device of this user up to date. A failure is only logged: a read is not in the
   * outbox, and the client sends it again when it reconnects with the chat open.
   */
  async read(chat: string, seq: number) {
    try {
      const state = await this.env.CHAT.get(this.env.CHAT.idFromName(chat)).markRead(this.uid, seq)
      if (!state) return
      this.sql.exec(
        'UPDATE chat SET read_seq = ?, unread = ? WHERE chat_id = ? AND read_seq <= ?',
        state.seq,
        state.unread ?? 0,
        chat,
        state.seq
      )
      this.receipt(state)
    } catch (error) {
      console.error('Read failed', error)
    }
  }

  /** Passes a read receipt to every device. Not stored: a device that misses one gets the reads with the chat. */
  receipt(frame: Extract<ServerFrame, { t: 'read' }>) {
    for (const ws of this.ctx.getWebSockets()) send(ws, frame)
  }

  /** Called by ChatDO with a chat's next log entries, in order. Safe to call again with entries already stored. */
  deliver(entries: Message[], peer: string) {
    for (const msg of entries) {
      const row = this.sql.exec<InboxRow>('SELECT * FROM chat WHERE chat_id = ?', msg.chat).toArray()[0]
      const current: Preview | null = row?.preview ? JSON.parse(row.preview) : null
      const preview = nextPreview(current, msg)
      const read = nextRead(
        { lastSeq: row?.last_seq ?? 0, readSeq: row?.read_seq ?? 0, unread: row?.unread ?? 0 },
        msg,
        this.uid
      )
      this.sql.exec(
        `INSERT INTO chat (chat_id, peer_id, last_seq, preview, updated_at, read_seq, unread) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (chat_id) DO UPDATE SET last_seq = ?3, preview = ?4, updated_at = ?5, read_seq = ?6, unread = ?7`,
        msg.chat,
        peer,
        read.lastSeq,
        preview && JSON.stringify(preview),
        // The chat moves up only for a new message, not for a change to an old one.
        preview && preview.seq !== current?.seq ? msg.ts : (row?.updated_at ?? msg.ts),
        read.readSeq,
        read.unread
      )
    }
    const frames = entries.map((msg) => JSON.stringify({ t: 'msg', msg } satisfies ServerFrame))
    for (const ws of this.ctx.getWebSockets()) for (const frame of frames) ws.send(frame)
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
