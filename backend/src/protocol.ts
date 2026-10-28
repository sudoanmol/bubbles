// Wire protocol shared by the backend and the frontend. Every WebSocket frame is parsed on both sides.
import * as v from 'valibot'

export const MAX_BODY = 4000

export const ChatId = v.pipe(v.string(), v.regex(/^[0-9a-z]{26,32}$/))

const Body = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_BODY))
const Seq = v.pipe(v.number(), v.integer(), v.minValue(1))
const Cid = v.pipe(v.string(), v.ulid())
const Emoji = v.pipe(v.string(), v.maxLength(32), v.regex(/^\p{Extended_Pictographic}/u))

/** A quote of the message being replied to, as it was when the reply was sent. */
const Reply = v.object({ seq: v.number(), sender: v.string(), body: v.string() })

/**
 * One entry in a chat's log; every entry gets the next `seq`. A `text` entry is a message, and its fields hold the
 * message's current state as of `rev` (the seq of the last change to it). A `patch` entry is an edit, delete or
 * reaction to the message at `target`, and carries that message's state after the change. Changes being log entries
 * means gap repair covers them too.
 */
const Entry = {
  chat: v.string(),
  seq: v.number(),
  cid: v.string(),
  sender: v.string(),
  ts: v.number(),
  body: v.string(),
  reply: v.nullable(Reply),
  /** When it was last edited. */
  edited: v.nullable(v.number()),
  deleted: v.boolean(),
  /** One reaction per person: user id → emoji. */
  reactions: v.record(v.string(), v.string()),
  rev: v.number(),
}
export const Message = v.variant('kind', [
  v.object({ ...Entry, kind: v.literal('text'), target: v.null() }),
  v.object({ ...Entry, kind: v.literal('patch'), target: v.number() }),
])
export type Message = v.InferOutput<typeof Message>
export type Text = Extract<Message, { kind: 'text' }>

/** The parts of a message that patches change. */
export type MessageState = Pick<Message, 'body' | 'reply' | 'edited' | 'deleted' | 'reactions'>

const OnMessage = { cid: Cid, chat: ChatId, seq: Seq }

export const ClientFrame = v.variant('t', [
  v.object({ t: v.literal('send'), cid: Cid, chat: ChatId, body: Body, reply: v.optional(Seq) }),
  v.object({ t: v.literal('edit'), ...OnMessage, body: Body }),
  v.object({ t: v.literal('delete'), ...OnMessage }),
  v.object({ t: v.literal('react'), ...OnMessage, emoji: v.nullable(Emoji) }),
  /** Read up to `seq`. Not stored in the outbox: the client sends it again whenever it reconnects with the chat open. */
  v.object({ t: v.literal('read'), chat: ChatId, seq: Seq }),
])
export type ClientFrame = v.InferOutput<typeof ClientFrame>
export type Patch = Extract<ClientFrame, { t: 'edit' | 'delete' | 'react' }>
export type Write = Exclude<ClientFrame, { t: 'read' }>

/** How long after sending a message you can still edit it, as in iMessage and WhatsApp. Deleting has no limit. */
export const EDIT_WINDOW_MS = 15 * 60_000

export const canEdit = (m: { sender: string; ts: number; deleted: boolean }, uid: string, now: number) =>
  m.sender === uid && !m.deleted && now - m.ts <= EDIT_WINDOW_MS

/**
 * A message's state after a patch by `uid` at `ts`, or an error message if the patch is not allowed. The server
 * applies it to store the change; the client applies it to show its own change before the server acks it.
 */
export function applyPatch(
  m: MessageState & { sender: string; ts: number },
  p: Patch,
  uid: string,
  ts: number
): MessageState | string {
  if (m.deleted) return 'That message was deleted'
  const state = { body: m.body, reply: m.reply, edited: m.edited, deleted: m.deleted, reactions: m.reactions }
  if (p.t === 'react') {
    const { [uid]: _, ...others } = m.reactions
    return { ...state, reactions: p.emoji ? { ...others, [uid]: p.emoji } : others }
  }
  if (m.sender !== uid) return 'You can only change your own messages'
  if (p.t === 'edit')
    return canEdit(m, uid, ts) ? { ...state, body: p.body, edited: ts } : 'Messages can only be edited for 15 minutes'
  return { ...state, body: '', reply: null, deleted: true, reactions: {} }
}

export const ServerFrame = v.variant('t', [
  /** The entry the server stored for one of this socket's frames (also sent again for a retry). */
  v.object({ t: v.literal('ack'), msg: Message }),
  v.object({ t: v.literal('msg'), msg: Message }),
  /**
   * The server refused the frame for good (not a member, the message is gone, not yours). A passing failure is never
   * an error frame: the server closes the socket instead, and the client replays its outbox on reconnect.
   */
  v.object({ t: v.literal('error'), cid: v.optional(v.string()), message: v.string() }),
  /**
   * A member read a chat up to `seq` at `ts`. Sent to every member; the reader's own devices also get `unread`, the
   * count of others' messages after `seq`, so reading on one device clears the badge on all of them.
   */
  v.object({
    t: v.literal('read'),
    chat: v.string(),
    uid: v.string(),
    seq: v.number(),
    ts: v.number(),
    unread: v.optional(v.number()),
  }),
])
export type ServerFrame = v.InferOutput<typeof ServerFrame>

export type Profile = { id: string; name: string; username: string; image: string | null }

/** The newest message in a chat, at its state as of `rev`. */
export type Preview = { seq: number; sender: string; body: string; deleted: boolean; rev: number }

/**
 * The preview after a log entry: a newer message replaces it, and a newer copy of it or a patch to it updates it.
 * Comparing revisions makes it safe to apply an entry twice. UserDO and the client both keep their inbox with it.
 */
export function nextPreview(cur: Preview | null, m: Message): Preview | null {
  if (m.kind === 'text')
    return cur && (m.seq < cur.seq || (m.seq === cur.seq && m.rev <= cur.rev))
      ? cur
      : { seq: m.seq, sender: m.sender, body: m.body, deleted: m.deleted, rev: m.rev }
  return cur?.seq === m.target && m.seq > cur.rev ? { ...cur, body: m.body, deleted: m.deleted, rev: m.seq } : cur
}

/** How far a user has read a chat, and how many messages from others came after that. */
export type ReadState = { lastSeq: number; readSeq: number; unread: number }

/**
 * The read state after a log entry: a new message from someone else adds an unread one; a new message you sent means
 * you've read the chat. Entries at or before `lastSeq` were counted already, so delivering one twice is safe. UserDO
 * and the client both keep their inbox with it.
 * ponytail: a message deleted while unread still counts until the next read.
 */
export function nextRead(s: ReadState, m: Message, uid: string): ReadState {
  if (m.kind !== 'text' || m.seq <= s.lastSeq) return { ...s, lastSeq: Math.max(s.lastSeq, m.seq) }
  if (m.sender === uid) return { lastSeq: m.seq, readSeq: m.seq, unread: 0 }
  return { ...s, lastSeq: m.seq, unread: s.unread + (m.seq > s.readSeq ? 1 : 0) }
}

export type InboxItem = ReadState & {
  chatId: string
  peer: Profile
  preview: Preview | null
  updatedAt: number
}

export type Read = { seq: number; ts: number }

/** `reads`: how far each member has read, by user id. */
export type Chat = { id: string; members: Profile[]; reads: Record<string, Read> }
