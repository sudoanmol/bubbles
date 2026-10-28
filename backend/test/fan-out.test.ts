// ChatDO fan-out in the Workers runtime: a member that can't be reached gets every entry later, in order, even if
// the chat object is evicted in between (`pnpm -C backend test`).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import type { ChatDO } from '../src/durable-objects/chat'

const chat = env.CHAT.get(env.CHAT.idFromName('fanout'))
const user = (uid: string) => env.USER.get(env.USER.idFromName(uid))
const send = (n: number) => ({ t: 'send', cid: `c${n}`, chat: 'fanout', body: `hi ${n}` }) as const

it('delivers to a member that was unreachable, after the chat restarts', async () => {
  await runInDurableObject(chat, async (instance: ChatDO, state) => {
    instance.init(['a', 'b'])
    // Every UserDO is down: the writes are stored and acked, but fan-out fails.
    const down = {
      idFromName: (name: string) => env.USER.idFromName(name),
      get: () => ({ deliver: () => Promise.reject(new Error('down')) }),
    }
    Object.assign(instance, { env: { ...env, USER: down } })
    for (const n of [1, 2, 3]) expect(instance.write('a', send(n))).toMatchObject({ seq: n })
    // The writes started a pass; let it fail, then fail twice more.
    while (instance.fanning) await new Promise((r) => setTimeout(r))
    await instance.fanOut()
    await instance.fanOut()
    // Each failed pass waits longer before the next try.
    expect((await state.storage.getAlarm())! - Date.now()).toBeGreaterThan(5_000)
    expect(state.storage.sql.exec('SELECT user_id, seq FROM delivery ORDER BY user_id').toArray()).toEqual([
      { user_id: 'a', seq: 0 },
      { user_id: 'b', seq: 0 },
    ])
  })

  // An eviction or a deploy drops everything in memory; the stored alarm finishes the job with the UserDOs back.
  await evictDurableObject(chat)
  expect(await runDurableObjectAlarm(chat)).toBe(true)

  for (const uid of ['a', 'b']) {
    const [row] = await user(uid).inbox()
    expect(row).toMatchObject({ chat_id: 'fanout', last_seq: 3 })
    expect(JSON.parse(row.preview!)).toMatchObject({ seq: 3, body: 'hi 3' })
  }
  expect(await runDurableObjectAlarm(chat)).toBe(false)
})
