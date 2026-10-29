import { Hono } from 'hono'

import { profiles } from '../db/profiles'
import { parseChatId, userDO, type AppEnv } from '../env'
import type { InboxItem, Preview } from '../protocol'

export const inbox = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await userDO(c.env, c.var.uid).inbox()
    // SAFETY: UserDO.deliver writes every row's preview, as a Preview in JSON.
    const previews = new Map(rows.map((r) => [r.chat_id, r.preview ? (JSON.parse(r.preview) as Preview) : null]))
    // DM peers, and who wrote each group's newest message ("Leo: who has the rope?").
    const ids = rows.flatMap((r) => (r.kind === 'dm' ? r.peer_id : (previews.get(r.chat_id)?.sender ?? [])))
    const people = await profiles(c.env.DB, [...new Set(ids)])

    return c.json(
      rows.flatMap((r): InboxItem[] => {
        const base = {
          chatId: r.chat_id,
          lastSeq: r.last_seq,
          readSeq: r.read_seq,
          unread: r.unread,
          preview: previews.get(r.chat_id) ?? null,
          updatedAt: r.updated_at,
        }

        if (r.kind === 'group') {
          const preview = base.preview && { ...base.preview, name: people.get(base.preview.sender)?.name }

          return [{ ...base, preview, kind: 'group', name: r.name ?? '', active: r.active === 1 }]
        }

        const peer = people.get(r.peer_id)

        return peer ? [{ ...base, kind: 'dm', peer }] : []
      })
    )
  })
  // "Delete chat" on a group this user is no longer in.
  .delete('/:id', async (c) => {
    await userDO(c.env, c.var.uid).forget(parseChatId(c.req.param('id')))

    return c.body(null, 204)
  })
