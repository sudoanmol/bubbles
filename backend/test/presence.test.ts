// Presence: watchers are told when someone comes online, and that they left only once the grace period is over.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'

import type { ServerFrame } from '../src/protocol'

const user = (uid: string) => env.USER.get(env.USER.idFromName(uid))

async function connect(uid: string) {
  const ws = (await user(uid).fetch('http://do/', { headers: { Upgrade: 'websocket' } })).webSocket!
  ws.accept()

  return ws
}

it('pushes presence to watchers, and going away only after the grace period', async () => {
  const frames: ServerFrame[] = []
  const watcher = await connect('watcher')
  // SAFETY: UserDO sends text frames only.
  watcher.addEventListener('message', (e) => frames.push(JSON.parse(e.data as string)))
  expect(await user('p').presence('watcher')).toEqual({ online: false, lastSeen: null })

  const p = await connect('p')
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ uid: 'p', online: true })))

  // A reload: the socket closes, but within the grace period they still show online and nobody is told otherwise.
  p.close()
  await vi.waitFor(async () =>
    expect(await runInDurableObject(user('p'), (_, state) => state.storage.kv.get('lastSeen'))).toBeTypeOf('number')
  )
  expect((await user('p').presence()).online).toBe(true)
  await runDurableObjectAlarm(user('p'))
  expect(frames.filter((f) => f.t === 'presence' && !f.online)).toHaveLength(0)

  // Grace over: watchers hear they left.
  await runInDurableObject(user('p'), async (_, state) => {
    state.storage.kv.put('lastSeen', Date.now() - 60_000)
    await state.storage.setAlarm(Date.now())
  })
  await runDurableObjectAlarm(user('p'))
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ t: 'presence', uid: 'p', online: false }))
})
