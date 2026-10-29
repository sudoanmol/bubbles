import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'

import { CONNECTS, FRAMES, isLocal, Window } from '../limits'
import {
  ClientFrame,
  nextGroup,
  nextPreview,
  nextRead,
  PING_MS,
  type Ephemeral,
  type Message,
  type Presence,
  type Preview,
  type ServerFrame,
} from '../protocol'
import { migrate } from './schema'

/**
 * A socket counts as alive while it has pinged recently. Three pings' worth, since a background tab may only run its
 * timers once a minute.
 */
const ALIVE_MS = 3 * PING_MS

/** How long after the last device leaves before watchers are told: a reload must not flicker "online" off and on. */
const GRACE_MS = 10_000

/** How long a watch lasts; an open chat renews it every minute by asking for presence again. */
const WATCH_MS = 150_000

/** A frame as it comes off a socket: JSON text. */
const Frame = v.pipe(v.string(), v.parseJson(), ClientFrame)

type InboxRow = {
  chat_id: string
  kind: 'dm' | 'group'
  /** The other person in a DM; empty for a group. */
  peer_id: string
  /** A group's name. */
  name: string | null
  /** 0 once this user has left the group, been removed, or it was deleted. */
  active: number
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
      // Users with a chat open that shows this user's presence, until their watch lapses.
      'CREATE TABLE watcher (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL);',
      `ALTER TABLE chat ADD COLUMN kind TEXT NOT NULL DEFAULT 'dm';
       ALTER TABLE chat ADD COLUMN name TEXT;
       ALTER TABLE chat ADD COLUMN active INTEGER NOT NULL DEFAULT 1;`,
    ])
    // Heartbeats are answered by the runtime, so an idle socket stays hibernated (and free) while proving it's alive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  get uid() {
    return this.ctx.id.name!
  }

  /** Accepts a hibernating WebSocket; the Worker has already authenticated the user. */
  frames = new Window(FRAMES)
  connects = new Window(CONNECTS)

  async fetch() {
    // The client backs off and tries again.
    if (!isLocal(this.env) && !this.connects.hit()) return new Response('Too many connections', { status: 429 })

    const { 0: client, 1: server } = new WebSocketPair()
    const wasOnline = this.presence().online
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ since: Date.now() })

    if (!wasOnline) this.announce()

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
      frame = v.parse(Frame, data)
    } catch {
      return send(ws, { t: 'error', message: 'Invalid frame' })
    }

    if (!isLocal(this.env) && !this.frames.hit()) {
      // A refusal, not a failure: the client shows the message as not sent instead of replaying it into the limit.
      if (frame.t === 'read' || frame.t === 'typing') return

      return send(ws, { t: 'error', cid: frame.cid, message: 'Slow down: too many messages' })
    }

    if (frame.t === 'read') return this.read(frame.chat, frame.seq)

    // Not awaited: typing is best effort and must not hold up the frames behind it.
    if (frame.t === 'typing')
      return void this.env.CHAT.get(this.env.CHAT.idFromName(frame.chat))
        .typing(this.uid)
        .catch((error) => console.error('Typing failed', error))
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
      this.push(state)
    } catch (error) {
      console.error('Read failed', error)
    }
  }

  /** Passes a receipt or a typing event to every device. Not stored: a device that misses a read gets it with the chat. */
  push(frame: Ephemeral) {
    for (const ws of this.ctx.getWebSockets()) send(ws, frame)
  }

  /** The last socket to close sets when the user was last seen; watchers hear about it once the grace period ends. */
  webSocketClose() {
    this.ctx.storage.kv.put('lastSeen', Date.now())

    if (!this.alive().length) void this.ctx.storage.setAlarm(Date.now() + GRACE_MS)
  }

  alarm() {
    if (!this.presence().online) this.announce()
  }

  /** Open sockets that pinged (or connected) recently. A phone that lost signal stops pinging and drops out. */
  alive() {
    const now = Date.now()

    return this.ctx.getWebSockets().filter((ws) => {
      // SAFETY: the only attachment a socket gets is the `{ since }` set when it is accepted.
      const since = (ws.deserializeAttachment() as { since: number } | null)?.since ?? 0
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0

      return ws.readyState === WebSocket.OPEN && now - Math.max(since, ping) < ALIVE_MS
    })
  }

  /**
   * Online while any device is alive, or within the grace period after the last one left. `watcher` (asking from a chat
   * they have open) is told of changes until their watch lapses.
   * ponytail: a device that dies silently is noticed by the next poll (within a minute), not pushed.
   */
  presence(watcher?: string): Presence {
    const now = Date.now()

    if (watcher) this.sql.exec('INSERT OR REPLACE INTO watcher (user_id, until) VALUES (?, ?)', watcher, now + WATCH_MS)
    const lastSeen = this.ctx.storage.kv.get<number>('lastSeen') ?? null

    return { online: this.alive().length > 0 || (lastSeen !== null && now - lastSeen < GRACE_MS), lastSeen }
  }

  /** Tells everyone watching this user that they came online or went away. */
  announce() {
    this.sql.exec('DELETE FROM watcher WHERE until < ?', Date.now())
    const frame = { t: 'presence', uid: this.uid, ...this.presence() } as const

    for (const { user_id } of this.sql.exec<{ user_id: string }>('SELECT user_id FROM watcher'))
      void this.env.USER.get(this.env.USER.idFromName(user_id))
        .push(frame)
        .catch((error) => console.error('Presence failed', error))
  }

  /** Called by ChatDO with a chat's next log entries, in order. Safe to call again with entries already stored. */
  deliver(entries: Message[], chat: { kind: 'dm'; peer: string } | { kind: 'group' }) {
    for (const msg of entries) {
      const row = this.sql.exec<InboxRow>('SELECT * FROM chat WHERE chat_id = ?', msg.chat).toArray()[0]
      const current: Preview | null = row?.preview ? JSON.parse(row.preview) : null
      const preview = nextPreview(current, msg)
      const lastSeq = row?.last_seq ?? 0
      const read = nextRead({ lastSeq, readSeq: row?.read_seq ?? 0, unread: row?.unread ?? 0 }, msg, this.uid)
      const was = { name: row?.name ?? '', active: (row?.active ?? 1) === 1 }
      const group = msg.seq > lastSeq ? nextGroup(was, msg, this.uid) : was
      this.sql.exec(
        `INSERT INTO chat (chat_id, kind, peer_id, last_seq, preview, updated_at, read_seq, unread, name, active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (chat_id) DO UPDATE SET last_seq = ?4, preview = ?5, updated_at = ?6, read_seq = ?7, unread = ?8,
           name = ?9, active = ?10`,
        msg.chat,
        chat.kind,
        chat.kind === 'dm' ? chat.peer : '',
        read.lastSeq,
        preview && JSON.stringify(preview),
        // The chat moves up only for a new message, not for a change to an old one.
        preview && preview.seq !== current?.seq ? msg.ts : (row?.updated_at ?? msg.ts),
        read.readSeq,
        read.unread,
        chat.kind === 'group' ? group.name : null,
        group.active ? 1 : 0
      )
    }

    const frames = entries.map((msg) => JSON.stringify({ t: 'msg', msg } satisfies ServerFrame))

    for (const ws of this.ctx.getWebSockets()) for (const frame of frames) ws.send(frame)
  }

  /** Adds a chat the user opened before anyone has written in it. */
  open(chat: string, peer: string) {
    this.sql.exec('INSERT OR IGNORE INTO chat (chat_id, peer_id, updated_at) VALUES (?, ?, ?)', chat, peer, Date.now())
  }

  /** Drops a group this user is no longer in from their inbox ("Delete chat"). */
  forget(chat: string) {
    this.sql.exec('DELETE FROM chat WHERE chat_id = ? AND active = 0', chat)
  }

  inbox() {
    return this.sql.exec<InboxRow>('SELECT * FROM chat ORDER BY updated_at DESC').toArray()
  }
}

function send(ws: WebSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame))
}
