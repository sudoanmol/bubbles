import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { user } from '../db/schema'
import { chatDO, userDO, type AppEnv } from '../env'

/** Opens (or creates) the DM with a username. A DM's id is derived from its two members, so it is created once. */
export const dms = new Hono<AppEnv>().post('/:username', async (c) => {
  const [peer] = await drizzle(c.env.DB)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, c.req.param('username').toLowerCase()))
  if (!peer) throw new HTTPException(404, { message: 'No one has that username' })

  const members = [...new Set([c.var.uid, peer.id])].sort()
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dm:${members.join(':')}`))
  const id = [...new Uint8Array(hash).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')

  await chatDO(c.env, id).init(members)
  await userDO(c.env, c.var.uid).open(id, peer.id)
  return c.json({ chatId: id })
})
