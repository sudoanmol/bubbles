import { Hono } from 'hono'

import { profiles } from '../db/profiles'
import { userDO, type AppEnv } from '../env'
import type { InboxItem } from '../protocol'

export const inbox = new Hono<AppEnv>().get('/', async (c) => {
  const rows = await userDO(c.env, c.var.uid).inbox()
  const people = await profiles(c.env.DB, [...new Set(rows.map((r) => r.peer_id))])
  return c.json(
    rows.flatMap((r): InboxItem[] => {
      const peer = people.get(r.peer_id)
      if (!peer) return []
      return [
        {
          chatId: r.chat_id,
          peer,
          lastSeq: r.last_seq,
          readSeq: r.read_seq,
          unread: r.unread,
          preview: r.preview && JSON.parse(r.preview),
          updatedAt: r.updated_at,
        },
      ]
    })
  )
})
