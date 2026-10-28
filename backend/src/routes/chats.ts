import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'

import { profiles } from '../db/profiles'
import { chatDO, parseChatId, type AppEnv } from '../env'
import type { Chat } from '../protocol'

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
  .get('/:id/messages', async (c) => {
    const cursors = v.safeParse(Cursors, c.req.query())
    if (!cursors.success) throw new HTTPException(400, { message: 'Bad cursor' })
    const { before, after } = cursors.output
    const page = await chatDO(c.env, parseChatId(c.req.param('id'))).messages(c.var.uid, { before, after })
    if (!page) throw new HTTPException(404, { message: 'Chat not found' })
    return c.json(page)
  })
