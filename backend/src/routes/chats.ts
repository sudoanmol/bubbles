import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'

import { profiles } from '../db/profiles'
import type { GroupOp } from '../durable-objects/chat'
import { chatDO, parseChatId, userDO, type AppEnv } from '../env'
import { GroupName, MAX_MEMBERS, type Chat, type Person, type Presence } from '../protocol'

const Seq = v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(0)))
const Cursors = v.object({ before: Seq, after: Seq })
const UserId = v.pipe(v.string(), v.minLength(1), v.maxLength(64))

const NewGroup = v.object({
  name: GroupName,
  members: v.pipe(v.array(UserId), v.minLength(1), v.maxLength(MAX_MEMBERS - 1)),
})

async function body<T extends v.GenericSchema>(c: Context<AppEnv>, schema: T): Promise<v.InferOutput<T>> {
  const parsed = v.safeParse(schema, await c.req.json().catch(() => null))

  if (!parsed.success) throw new HTTPException(400, { message: parsed.issues[0].message })

  return parsed.output
}

/** Users by id, with their names, for group events; every one must exist and have picked a username. */
async function people(env: CloudflareBindings, ids: string[]): Promise<Person[]> {
  const found = await profiles(env.DB, ids)

  return ids.map((id) => {
    const p = found.get(id)

    if (!p?.username) throw new HTTPException(404, { message: 'No such user' })

    return { id: p.id, name: p.name }
  })
}

/** Applies a group change by the signed-in user; `ids` are the other people it names, resolved to names first. */
async function manage(c: Context<AppEnv>, op: (named: Person[]) => GroupOp, ids: string[] = []) {
  const [by, ...named] = await people(c.env, [c.var.uid, ...ids])
  const result = await chatDO(c.env, parseChatId(c.req.param('id') ?? '')).manage(c.var.uid, by, op(named))

  if ('refused' in result) throw new HTTPException(403, { message: result.refused })

  return c.json(result)
}

export const chats = new Hono<AppEnv>()
  // A new group; the creator is its admin.
  .post('/', async (c) => {
    const { name, members } = await body(c, NewGroup)
    const id = crypto.randomUUID().replaceAll('-', '')
    const everyone = await people(c.env, [...new Set([c.var.uid, ...members])])
    await chatDO(c.env, id).create(c.var.uid, name, everyone)

    return c.json({ chatId: id })
  })
  .get('/:id', async (c) => {
    const id = parseChatId(c.req.param('id'))
    const info = await chatDO(c.env, id).info(c.var.uid)

    if (!info) throw new HTTPException(404, { message: 'Chat not found' })

    const found = await profiles(
      c.env.DB,
      info.members.map((r) => r.user_id)
    )

    const members = info.members.flatMap((r) => {
      const p = found.get(r.user_id)

      return p ? [{ ...p, role: r.role, left: r.left_seq }] : []
    })

    const reads = Object.fromEntries(info.members.map((r) => [r.user_id, { seq: r.read_seq, ts: r.read_ts }]))
    const me = info.members.find((r) => r.user_id === c.var.uid)!
    const group = info.group && { ...info.group, leftBy: me.left_by }

    return c.json({ id, members, reads, group } satisfies Chat)
  })
  .patch('/:id', async (c) => {
    const { name } = await body(c, v.object({ name: GroupName }))

    return manage(c, () => ({ t: 'rename', name }))
  })
  .delete('/:id', (c) => manage(c, () => ({ t: 'delete' })))
  .post('/:id/members', async (c) => {
    const { ids } = await body(c, v.object({ ids: v.pipe(v.array(UserId), v.minLength(1), v.maxLength(MAX_MEMBERS)) }))

    return manage(c, (users) => ({ t: 'add', users }), [...new Set(ids)])
  })
  .delete('/:id/members/:uid', (c) => manage(c, ([user]) => ({ t: 'remove', user }), [c.req.param('uid')]))
  .patch('/:id/members/:uid', async (c) => {
    const { admin } = await body(c, v.object({ admin: v.boolean() }))

    return manage(c, ([user]) => ({ t: 'admin', user, admin }), [c.req.param('uid')])
  })
  // Leaving; the only admin names a successor.
  .post('/:id/leave', async (c) => {
    const { successor } = await body(c, v.object({ successor: v.optional(UserId) }))

    return manage(c, ([next]) => ({ t: 'leave', successor: next }), successor ? [successor] : [])
  })
  // Asked when a chat opens and every minute while it stays open; each ask also (re)subscribes the asker to changes.
  // ponytail: one UserDO call per member per poll; show a count instead for big groups.
  .get('/:id/presence', async (c) => {
    const rows = await chatDO(c.env, parseChatId(c.req.param('id'))).members(c.var.uid)

    if (!rows) throw new HTTPException(404, { message: 'Chat not found' })
    const others = rows.filter((r) => r.user_id !== c.var.uid && r.left_seq === null)

    const entries = await Promise.all(
      others.map(async (r): Promise<[string, Presence]> => [
        r.user_id,
        await userDO(c.env, r.user_id).presence(c.var.uid),
      ])
    )

    return c.json(Object.fromEntries(entries))
  })
  .get('/:id/messages', async (c) => {
    const cursors = v.safeParse(Cursors, c.req.query())

    if (!cursors.success) throw new HTTPException(400, { message: 'Bad cursor' })
    const { before, after } = cursors.output
    const page = await chatDO(c.env, parseChatId(c.req.param('id'))).messages(c.var.uid, { before, after })

    if (!page) throw new HTTPException(404, { message: 'Chat not found' })

    return c.json(page)
  })
