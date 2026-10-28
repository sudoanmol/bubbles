import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'

import { ChatId } from './protocol'

/** Hono env for routes behind the auth middleware: `uid` is the signed-in user. */
export type AppEnv = { Bindings: CloudflareBindings; Variables: { uid: string } }

export const userDO = (env: CloudflareBindings, id: string) => env.USER.get(env.USER.idFromName(id))
export const chatDO = (env: CloudflareBindings, id: string) => env.CHAT.get(env.CHAT.idFromName(id))

/** Unknown or malformed chat ids are a 404, the same as chats the user is not in. */
export function parseChatId(id: string) {
  const parsed = v.safeParse(ChatId, id)
  if (!parsed.success) throw new HTTPException(404, { message: 'Chat not found' })
  return parsed.output
}
