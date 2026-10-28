// Read state across ChatDO and UserDO: unread counts follow deliveries and reads, and a read never goes backwards.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import type { ChatDO } from '../src/durable-objects/chat'

const chat = env.CHAT.get(env.CHAT.idFromName('reads'))
const user = (uid: string) => env.USER.get(env.USER.idFromName(uid))
const send = (cid: string) => ({ t: 'send', cid, chat: 'reads', body: cid }) as const
const row = async (uid: string) => (await user(uid).inbox()).find((r) => r.chat_id === 'reads')

it('counts unread messages and clears them on read or reply', async () => {
  const write = (uid: string, cid: string) =>
    runInDurableObject(chat, async (instance: ChatDO) => {
      instance.init(['a', 'b'])
      instance.write(uid, send(cid))
      while (instance.fanning) await new Promise((r) => setTimeout(r))
    })
  for (const cid of ['b1', 'b2', 'b3']) await write('b', cid)
  expect(await row('a')).toMatchObject({ last_seq: 3, read_seq: 0, unread: 3 })
  expect(await row('b')).toMatchObject({ read_seq: 3, unread: 0 })

  await user('a').read('reads', 2)
  expect(await row('a')).toMatchObject({ read_seq: 2, unread: 1 })
  // A late or repeated read from another device doesn't move it back.
  await user('a').read('reads', 1)
  expect(await row('a')).toMatchObject({ read_seq: 2, unread: 1 })
  // Past the end is clamped to the end.
  await user('a').read('reads', 99)
  expect(await row('a')).toMatchObject({ read_seq: 3, unread: 0 })

  await write('b', 'b4')
  expect(await row('a')).toMatchObject({ unread: 1 })
  // Replying means you've read it.
  await write('a', 'a5')
  expect(await row('a')).toMatchObject({ read_seq: 5, unread: 0 })
  expect((await chat.members('a'))?.find((m) => m.user_id === 'a')?.read_seq).toBe(5)
})
