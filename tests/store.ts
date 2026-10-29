// Checks the device store (frontend/src/lib/store.ts) against an in-memory IndexedDB: `pnpm test`.
// Importing the module twice under different URLs gives two tabs with their own connections to one database.

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

import type { Text } from '../backend/src/protocol.ts'
import type { Pending } from '../frontend/src/lib/log.ts'

type Store = typeof import('../frontend/src/lib/store.ts')

const tab = (n: number): Promise<Store> => import(`../frontend/src/lib/store.ts?tab=${n}`)
const one = await tab(1)
const two = await tab(2)

/** Fails instead of hanging when a step never settles (a blocked delete). */
const settles = <T>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} hung`)), 1000))])

const chat = 'c'

const text = (seq: number, rev = seq, cid = `t${seq}`): Text => ({
  chat,
  seq,
  cid,
  sender: 'a',
  ts: seq,
  kind: 'text',
  body: `rev ${rev}`,
  reply: null,
  target: null,
  edited: null,
  deleted: false,
  reactions: {},
  images: [],
  link: null,
  rev,
})

const send = (cid: string): Pending => ({ t: 'send', chat, cid, body: 'hi', local: { ...text(0, 0, cid), seq: null } })

// Unsent frames survive a reload (here: the tab switching accounts and back, which reopens the database).
one.openStore('a')

await one.saveOutbox(send('01B'))

await one.saveOutbox(send('01A'))

one.openStore('b')

one.openStore('a')

assert.deepEqual(
  (await one.allOutbox()).map((p) => p.cid),
  ['01A', '01B'],
  'outbox replays in write order after reopening'
)

// A stale copy never replaces a newer one, and storing an entry clears its frame from the outbox.
await one.saveMessages(chat, [text(1, 3, '01A')])

await one.saveMessages(chat, [text(1, 1, '01A')])

assert.equal((await one.cachedMessages(chat, 10))[0].rev, 3, 'a stale copy lowered rev')

assert.deepEqual(
  (await one.allOutbox()).map((p) => p.cid),
  ['01B'],
  'the acked frame left the outbox'
)

// Gap repair that jumped to the latest page drops the older copy, so what is stored stays one unbroken run.
await one.saveMessages(chat, [text(2), text(3)])

await one.saveMessages(chat, [text(60), text(61)], 60)

assert.deepEqual(
  (await one.cachedMessages(chat, 10)).map((m) => m.seq),
  [60, 61]
)

// A response that comes back after another account signed in is refused before it is stored.
const uid = one.currentUid()

one.openStore('b')

assert.throws(() => one.checkAccount(uid), /someone else/)

one.openStore('a')

// Signing out in one tab deletes the database even while another tab has it open; that tab lets go of it.
two.openStore('a')

assert.equal((await two.allOutbox()).length, 1, 'the second tab sees the same database')

await settles(one.deleteStore(), 'sign-out in tab one')

assert.equal(two.currentUid(), undefined, 'tab two still holds the deleted database')

assert.deepEqual(await settles(two.allOutbox(), 'tab two after sign-out'), [])

// The other way round: the tab signing out is the one that let go first.
one.openStore('a')

two.openStore('a')

await one.saveOutbox(send('01C'))

await settles(two.deleteStore(), 'sign-out in tab two')

one.openStore('a')

assert.deepEqual(await one.allOutbox(), [], 'sign-out left data behind')

console.log('PASS: device store')
