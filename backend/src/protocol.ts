// Wire protocol shared by the backend and the frontend. Every WebSocket frame is parsed on both sides.
import * as v from 'valibot'

export const MAX_BODY = 4000

export const ChatId = v.pipe(v.string(), v.regex(/^[0-9a-z]{26,32}$/))

const Body = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_BODY))

export const Message = v.object({
  chat: v.string(),
  seq: v.number(),
  cid: v.string(),
  sender: v.string(),
  body: v.string(),
  ts: v.number(),
})
export type Message = v.InferOutput<typeof Message>

export const ClientFrame = v.variant('t', [
  v.object({ t: v.literal('send'), cid: v.pipe(v.string(), v.ulid()), chat: ChatId, body: Body }),
])
export type ClientFrame = v.InferOutput<typeof ClientFrame>

export const ServerFrame = v.variant('t', [
  v.object({ t: v.literal('ack'), chat: v.string(), cid: v.string(), seq: v.number(), ts: v.number() }),
  v.object({ t: v.literal('msg'), msg: Message }),
  v.object({ t: v.literal('error'), cid: v.optional(v.string()), message: v.string() }),
])
export type ServerFrame = v.InferOutput<typeof ServerFrame>

export type Profile = { id: string; name: string; username: string; image: string | null }

export type InboxItem = {
  chatId: string
  peer: Profile
  lastSeq: number
  preview: { sender: string; body: string } | null
  updatedAt: number
}

export type Chat = { id: string; members: Profile[] }

export type MessagePage = { messages: Message[]; hasOlder: boolean }
