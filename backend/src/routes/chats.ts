import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'

import { profiles } from '../db/profiles'
import { chatDO, parseChatId, userDO, type AppEnv } from '../env'
import type { Chat, Presence } from '../protocol'

const Seq = v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(0)))
const Cursors = v.object({ before: Seq, after: Seq })

export const chats = new Hono<AppEnv>()
  .get('/:id', async (c) => {
    const id = parseChatId(c.req.param('id'))
    const rows = await chatDO(c.env, id).members(c.var.uid)
    if (!rows) throw new HTTPException(404, { message: 'Chat not found' })
    const people = await profiles(
      c.env.DB,
      rows.map((r) => r.user_id)
    )
    return c.json({
      id,
      members: rows.flatMap((r) => people.get(r.user_id) ?? []),
      reads: Object.fromEntries(rows.map((r) => [r.user_id, { seq: r.read_seq, ts: r.read_ts }])),
    } satisfies Chat)
  })
  // Polled while the chat is open.
  // ponytail: one UserDO call per member per poll; show a count instead for big groups.
  .get('/:id/presence', async (c) => {
    const rows = await chatDO(c.env, parseChatId(c.req.param('id'))).members(c.var.uid)
    if (!rows) throw new HTTPException(404, { message: 'Chat not found' })
    const others = rows.filter((r) => r.user_id !== c.var.uid)
    const entries = await Promise.all(others.map(async (r) => [r.user_id, await userDO(c.env, r.user_id).presence()]))
    return c.json(Object.fromEntries(entries) as Record<string, Presence>)
  })
  .get('/:id/messages', async (c) => {
    const cursors = v.safeParse(Cursors, c.req.query())
    if (!cursors.success) throw new HTTPException(400, { message: 'Bad cursor' })
    const { before, after } = cursors.output
    const page = await chatDO(c.env, parseChatId(c.req.param('id'))).messages(c.var.uid, { before, after })
    if (!page) throw new HTTPException(404, { message: 'Chat not found' })
    return c.json(page)
  })
