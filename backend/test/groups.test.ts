// Groups: removal cuts delivery at the entry that says so, a group always keeps an admin, and someone added back
// doesn't receive what was said while they were out.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import type { ChatDO, GroupOp } from '../src/durable-objects/chat'

const chat = env.CHAT.get(env.CHAT.idFromName('group'))
const user = (uid: string) => env.USER.get(env.USER.idFromName(uid))
const p = (id: string) => ({ id, name: id.toUpperCase() })
const row = async (uid: string) => (await user(uid).inbox()).find((r) => r.chat_id === 'group')

/** Runs `fn` in the chat and waits for its fan-out to finish. */
const inChat = <T>(fn: (c: ChatDO) => T) =>
  runInDurableObject(chat, async (instance: ChatDO) => {
    const out = fn(instance)
    while (instance.fanning) await new Promise((r) => setTimeout(r))
    return out
  })
const send = (uid: string, cid: string) => inChat((c) => c.write(uid, { t: 'send', cid, chat: 'group', body: cid }))
const manage = (uid: string, op: GroupOp) => inChat((c) => c.manage(uid, p(uid), op))

it('runs a group: removal, admins, leaving and coming back', async () => {
  await inChat((c) => c.create('a', 'Climbers', [p('a'), p('b'), p('c')]))
  expect(await row('b')).toMatchObject({ kind: 'group', name: 'Climbers', active: 1, last_seq: 2 })

  // Only admins remove people.
  expect(await manage('b', { t: 'remove', user: p('c') })).toEqual({ refused: 'Only admins can do that' })
  await manage('a', { t: 'remove', user: p('c') })
  await send('a', 'after')
  // c got the entry removing them (seq 3), and nothing after it, live or from history.
  expect(await row('c')).toMatchObject({ last_seq: 3, active: 0 })
  expect((await inChat((c) => c.messages('c')))?.map((m) => m.seq)).toEqual([1, 2, 3])
  expect(await inChat((c) => c.write('c', { t: 'send', cid: 'c1', chat: 'group', body: 'hi' }))).toEqual({
    refused: 'Not a member of this chat',
  })

  // The only admin can't leave without handing over, and the successor becomes admin as they go.
  expect(await manage('a', { t: 'leave' })).toEqual({ refused: 'Choose a new admin first' })
  await manage('a', { t: 'leave', successor: p('b') })
  expect((await chat.members('b'))?.find((m) => m.user_id === 'b')?.role).toBe('admin')
  expect(await row('a')).toMatchObject({ active: 0 })

  // c comes back: from the entry adding them, not the messages in between.
  await send('b', 'while-c-was-out')
  await manage('b', { t: 'add', users: [p('c')] })
  await send('b', 'welcome')
  const cRow = await row('c')
  expect(cRow).toMatchObject({ active: 1, unread: 1 })
  expect(JSON.parse(cRow!.preview!).body).toBe('welcome')
})
