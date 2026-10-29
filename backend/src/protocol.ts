// Wire protocol shared by the backend and the frontend. Every WebSocket frame is parsed on both sides.
import * as v from 'valibot'

export const MAX_BODY = 4000

export const ChatId = v.pipe(v.string(), v.regex(/^[0-9a-z]{26,32}$/))

const Body = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_BODY))

/** A message's text, which may be empty when it has photos. */
const Caption = v.pipe(v.string(), v.trim(), v.maxLength(MAX_BODY))
const Seq = v.pipe(v.number(), v.integer(), v.minValue(1))
const Cid = v.pipe(v.string(), v.ulid())
const Emoji = v.pipe(v.string(), v.maxLength(32), v.regex(/^\p{Extended_Pictographic}/u))

/** A quote of the message being replied to, as it was when the reply was sent. */
const Reply = v.object({ seq: v.number(), sender: v.string(), body: v.string() })

export const MAX_IMAGES = 5
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** An uploaded photo: its storage key (`<uploader id>/<ulid>`, see routes/media.ts) and size, to lay it out unloaded. */
const Image = v.object({
  key: v.pipe(v.string(), v.regex(/^[\w-]{1,64}\/[0-9A-Z]{26}$/)),
  w: v.pipe(v.number(), v.integer(), v.minValue(1)),
  h: v.pipe(v.number(), v.integer(), v.minValue(1)),
})

export type Image = v.InferOutput<typeof Image>

/** Where a photo is served from. */
export const mediaUrl = (key: string) => `/api/media/${key}`

/** The card for a message's first link, filled in by the server once it has fetched the page. */
const Link = v.object({
  url: v.string(),
  site: v.string(),
  title: v.string(),
  description: v.nullable(v.string()),
  image: v.nullable(v.string()),
})

export type Link = v.InferOutput<typeof Link>

/** URLs in a message's text: http(s) ones and bare www. ones. */
const URLS = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi

/**
 * The links in a text, with where each starts and ends. Trailing punctuation is left out, so "see x.com/a." links
 * x.com/a. ponytail: a URL ending in ")" loses it (some Wikipedia links); balance parentheses if that comes up.
 */
export function findLinks(text: string) {
  return [...text.matchAll(URLS)].map((m) => {
    const raw = m[0].replace(/[.,;:!?)\]'"]+$/, '')

    return { start: m.index, end: m.index + raw.length, href: raw.startsWith('www.') ? `https://${raw}` : raw }
  })
}

/** The URL a message's card is for. */
export const firstLink = (text: string) => findLinks(text)[0]?.href ?? null

/**
 * One entry in a chat's log; every entry gets the next `seq`. A `text` entry is a message, and its fields hold the
 * message's current state as of `rev` (the seq of the last change to it). A `patch` entry is an edit, delete or
 * reaction to the message at `target`, and carries that message's state after the change. A `system` entry is a
 * change to a group (its body is a GroupEvent as JSON). Changes being log entries means gap repair covers them too.
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
  images: v.array(Image),
  link: v.nullable(Link),
  rev: v.number(),
}

export const Message = v.variant('kind', [
  v.object({ ...Entry, kind: v.literal('text'), target: v.null() }),
  v.object({ ...Entry, kind: v.literal('patch'), target: v.number() }),
  v.object({ ...Entry, kind: v.literal('system'), target: v.null() }),
])

export type Message = v.InferOutput<typeof Message>

export type Text = Extract<Message, { kind: 'text' }>

export type System = Extract<Message, { kind: 'system' }>

/** Most members a group can have: ChatDO fans every entry out to each of them. */
export const MAX_MEMBERS = 256
export const MAX_GROUP_NAME = 60
export const GroupName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_GROUP_NAME))

/** Someone named in a group event, with their name as it was then, so the event reads the same everywhere. */
export type Person = { id: string; name: string }

/** A change to a group, made by `by`. Stored as the body of a `system` entry. */
export type GroupEvent =
  | { t: 'created'; by: Person; name: string }
  | { t: 'added'; by: Person; users: Person[]; name: string }
  | { t: 'left'; by: Person }
  | { t: 'removed'; by: Person; user: Person }
  | { t: 'renamed'; by: Person; name: string }
  | { t: 'admin'; by: Person; user: Person; admin: boolean }
  | { t: 'deleted'; by: Person }

// SAFETY: ChatDO.system writes every `system` entry, and its body is always a GroupEvent as JSON.
export const groupEvent = (body: string) => JSON.parse(body) as GroupEvent

/** The parts of a message that patches change. */
export type MessageState = Pick<Message, 'body' | 'reply' | 'edited' | 'deleted' | 'reactions' | 'images' | 'link'>

const OnMessage = { cid: Cid, chat: ChatId, seq: Seq }

export const ClientFrame = v.variant('t', [
  /** Text, photos with an optional caption, or both. The photos are uploaded before this is sent. */
  v.pipe(
    v.object({
      t: v.literal('send'),
      cid: Cid,
      chat: ChatId,
      body: Caption,
      reply: v.optional(Seq),
      images: v.optional(v.pipe(v.array(Image), v.maxLength(MAX_IMAGES))),
    }),
    v.check((f) => f.body !== '' || !!f.images?.length, 'Empty message')
  ),
  v.object({ t: v.literal('edit'), ...OnMessage, body: Body }),
  v.object({ t: v.literal('delete'), ...OnMessage }),
  v.object({ t: v.literal('react'), ...OnMessage, emoji: v.nullable(Emoji) }),
  /** Read up to `seq`. Not stored in the outbox: the client sends it again whenever it reconnects with the chat open. */
  v.object({ t: v.literal('read'), chat: ChatId, seq: Seq }),
  /** Typing in a chat; sent at most every few seconds while typing. Passed on to the other members, never stored. */
  v.object({ t: v.literal('typing'), chat: ChatId }),
])

export type ClientFrame = v.InferOutput<typeof ClientFrame>

export type Patch = Extract<ClientFrame, { t: 'edit' | 'delete' | 'react' }>

export type Write = Exclude<ClientFrame, { t: 'read' | 'typing' }>

/** How long after sending a message you can still edit it, as in iMessage and WhatsApp. Deleting has no limit. */
export const EDIT_WINDOW_MS = 15 * 60_000

export const canEdit = (m: { sender: string; ts: number; deleted: boolean }, uid: string, now: number) =>
  m.sender === uid && !m.deleted && now - m.ts <= EDIT_WINDOW_MS

/** Why the server won't take a frame; sent to the client as an `error` frame. */
export type Refused = { refused: string }

/**
 * A message's state after a patch by `uid` at `ts`, or a refusal if the patch is not allowed. The server applies it
 * to store the change; the client applies it to show its own change before the server acks it.
 */
export function applyPatch(
  m: MessageState & { sender: string; ts: number },
  p: Patch,
  uid: string,
  ts: number
): MessageState | Refused {
  if (m.deleted) return { refused: 'That message was deleted' }
  const { body, reply, edited, deleted, reactions, images, link } = m
  const state = { body, reply, edited, deleted, reactions, images, link }

  if (p.t === 'react') {
    const { [uid]: _, ...others } = m.reactions

    return { ...state, reactions: p.emoji ? { ...others, [uid]: p.emoji } : others }
  }

  if (m.sender !== uid) return { refused: 'You can only change your own messages' }

  // An edit keeps the card only while the text still starts with its link; the server unfurls a new one.
  if (p.t === 'edit')
    return canEdit(m, uid, ts)
      ? { ...state, body: p.body, edited: ts, link: link?.url === firstLink(p.body) ? link : null }
      : { refused: 'Messages can only be edited for 15 minutes' }

  return { ...state, body: '', reply: null, deleted: true, reactions: {}, images: [], link: null }
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
  /** A member is typing in a chat. Shown for a few seconds, or until their message arrives. */
  v.object({ t: v.literal('typing'), chat: v.string(), uid: v.string() }),
  /** Someone this user is watching (a member of a chat they have open) came online or went away. */
  v.object({ t: v.literal('presence'), uid: v.string(), online: v.boolean(), lastSeen: v.nullable(v.number()) }),
])

export type ServerFrame = v.InferOutput<typeof ServerFrame>

/** Ephemeral frames: passed to a user's devices as they happen, never stored or retried. */
export type Ephemeral = Extract<ServerFrame, { t: 'read' | 'typing' | 'presence' }>

/** How often each device pings its socket; Cloudflare answers without waking the UserDO. */
export const PING_MS = 30_000

/** Whether a user has a device connected now, and when their last one disconnected (null if never seen). */
export type Presence = { online: boolean; lastSeen: number | null }

export type Profile = { id: string; name: string; username: string; image: string | null }

/**
 * The newest message or group event in a chat, at its state as of `rev`. `name` is the sender's name in a group,
 * filled in where it's known (the inbox API, or the chat's member list).
 */
export type Preview = {
  seq: number
  kind: 'text' | 'system'
  sender: string
  body: string
  deleted: boolean
  rev: number
  name?: string
}

/**
 * The preview after a log entry: a newer message replaces it, and a newer copy of it or a patch to it updates it.
 * Comparing revisions makes it safe to apply an entry twice. UserDO and the client both keep their inbox with it.
 */
export function nextPreview(cur: Preview | null, m: Message): Preview | null {
  if (m.kind !== 'patch')
    return cur && (m.seq < cur.seq || (m.seq === cur.seq && m.rev <= cur.rev))
      ? cur
      : { seq: m.seq, kind: m.kind, sender: m.sender, body: previewText(m), deleted: m.deleted, rev: m.rev }

  return cur?.seq === m.target && m.seq > cur.rev
    ? { ...cur, body: previewText(m), deleted: m.deleted, rev: m.seq }
    : cur
}

/** A message as one line: photos show as "📷 Photo", or the camera and their caption. */
export const previewText = (m: Pick<Message, 'body' | 'images'>) =>
  m.images.length ? `📷 ${m.body || (m.images.length > 1 ? 'Photos' : 'Photo')}` : m.body

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

/** A group's name, and whether this user is still in it. */
export type GroupState = { name: string; active: boolean }

/**
 * A group's state after a log entry, as seen by `uid`: a new name, or `uid` joining or leaving it (left, removed, or
 * the group deleted). Callers skip entries they've applied already. UserDO and the client both keep their inbox with it.
 */
export function nextGroup(s: GroupState, m: Message, uid: string): GroupState {
  if (m.kind !== 'system') return s
  const e = groupEvent(m.body)

  switch (e.t) {
    case 'created':
    case 'renamed':
      return { ...s, name: e.name }
    case 'added':
      // Carries the current name, so someone added back sees a rename they missed while out.
      return e.users.some((u) => u.id === uid) ? { name: e.name, active: true } : s
    case 'removed':
      return e.user.id === uid ? { ...s, active: false } : s
    case 'left':
      return e.by.id === uid ? { ...s, active: false } : s
    case 'deleted':
      return { ...s, active: false }
    default:
      return s
  }
}

export type InboxItem = ReadState & {
  chatId: string
  preview: Preview | null
  updatedAt: number
} & ({ kind: 'dm'; peer: Profile } | ({ kind: 'group' } & GroupState))

export type Read = { seq: number; ts: number }

export type Role = 'admin' | 'member'

/**
 * A chat member. `left` is the seq of the entry that took them out (left, removed, or the group deleted), or null while
 * they're in it; they stay listed for the history's sake.
 */
export type Member = Profile & { role: Role; left: number | null }

/**
 * `reads`: how far each member has read, by user id. `group` is null for a DM; for a user no longer in the group,
 * `leftBy` says why: who removed them, themselves if they left, or whoever deleted the group.
 */
export type Chat = {
  id: string
  members: Member[]
  reads: Record<string, Read>
  group: { name: string; deleted: boolean; leftBy: string | null } | null
}
