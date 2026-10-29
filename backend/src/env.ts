import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'

import { ChatId } from './protocol'

/** Hono env for routes behind the auth middleware: `uid` is the signed-in user. */
export type AppEnv = { Bindings: CloudflareBindings; Variables: { uid: string } }

export const userDO = (env: CloudflareBindings, id: string) => env.USER.get(env.USER.idFromName(id))
export const chatDO = (env: CloudflareBindings, id: string) => env.CHAT.get(env.CHAT.idFromName(id))

/**
 * Whether `key` is under `limiter`'s limit. Local runs skip limits (the chaos test floods the socket on purpose). Keyed
 * off BETTER_AUTH_URL like the dev routes, so production cannot switch them off.
 * ponytail: the binding counts per Cloudflare location and approximately; a Durable Object counter if it must be strict.
 */
export async function allowed(env: CloudflareBindings, limiter: RateLimit, key: string) {
  if (new URL(env.BETTER_AUTH_URL).hostname === 'localhost') return true

  return (await limiter.limit({ key })).success
}

/** Unknown or malformed chat ids are a 404, the same as chats the user is not in. */
export function parseChatId(id: string) {
  const parsed = v.safeParse(ChatId, id)

  if (!parsed.success) throw new HTTPException(404, { message: 'Chat not found' })

  return parsed.output
}
