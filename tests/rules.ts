// Checks the pure log rules every copy of a chat must agree on: `pnpm test`.
// Entries arrive twice, late, stale and out of order; the result must not depend on any of that.

import assert from 'node:assert/strict'

import { nextPreview, type Message, type Text } from '../backend/src/protocol.ts'
import { cursor, merge, withPending, type Pending } from '../frontend/src/lib/log.ts'

const chat = 'c'
const text = (seq: number, over: Partial<Text> = {}): Text => ({
  chat,
  seq,
  cid: `t${seq}`,
  sender: 'a',
  ts: seq,
  kind: 'text',
  body: `hi ${seq}`,
  reply: null,
  target: null,
  edited: null,
  deleted: false,
  reactions: {},
  rev: seq,
  ...over,
})
const patch = (seq: number, target: number, state: Partial<Text>): Message => ({
  ...text(seq, { cid: `p${seq}`, ...state }),
  kind: 'patch',
  target,
})

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))
}

// Message 1 is edited (seq 2), then reacted to (seq 3). The server's copy of message 1 is seen before the changes
// (rev 1), and sometimes after them too (rev 3). Every arrival order, one entry at a time, ends in the same state:
// without the fresh copy, only folding the patches into the stale one gets there.
const stale = [
  text(1),
  patch(2, 1, { body: 'edited', edited: 2 }),
  patch(3, 1, { body: 'edited', edited: 2, reactions: { b: '👍' } }),
]
const fresh = text(1, { body: 'edited', edited: 2, reactions: { b: '👍' }, rev: 3 })
for (const order of [...permutations(stale), ...permutations([...stale, fresh])]) {
  const log = order.reduce<Message[]>((held, m) => merge(held, [m]), [])
  assert.deepEqual(
    log.map((m) => [m.seq, m.body, m.reactions, m.rev]),
    [
      [1, 'edited', { b: '👍' }, 3],
      [2, 'edited', {}, 2],
      [3, 'edited', { b: '👍' }, 3],
    ],
    `order ${order.map((m) => `${m.cid}@${m.rev}`).join(' ')}`
  )
}

// The inbox preview: a newer message replaces it, an edit to it updates it, and nothing older or repeated undoes that.
const previewOf = (ms: Message[]) => ms.reduce(nextPreview, null)
const edited = { seq: 1, sender: 'a', body: 'edited', deleted: false, rev: 2 }
assert.deepEqual(previewOf([text(1), patch(2, 1, { body: 'edited' })]), edited)
assert.deepEqual(
  previewOf([text(1), patch(2, 1, { body: 'edited' }), text(1), patch(2, 1, { body: 'edited' })]),
  edited
)
assert.deepEqual(previewOf([text(1), text(3), patch(2, 1, { body: 'edited' })]), {
  seq: 3,
  sender: 'a',
  body: 'hi 3',
  deleted: false,
  rev: 3,
})

// Unsent changes stay on top of whatever the server confirms meanwhile: a delete still pending survives someone
// else's reaction, and a later edit survives the ack of an earlier one.
const uid = 'a'
const outbox: Pending[] = [
  { t: 'delete', chat, cid: 'x1', seq: 1 },
  { t: 'edit', chat, cid: 'x2', seq: 4, body: 'second' },
  {
    t: 'send',
    chat,
    cid: 'x3',
    body: 'new',
    local: { ...text(0, { cid: 'x3', body: 'new' }), seq: null },
  },
]
const confirmed = merge(
  [text(1), text(4)],
  [patch(5, 1, { reactions: { b: '🔥' } }), patch(6, 4, { body: 'first', edited: 6 })]
)
const shown = withPending(chat, confirmed, outbox, uid)
assert.deepEqual(
  shown.map((m) => [m.seq, m.deleted, m.body]),
  [
    [1, true, ''],
    [4, false, 'second'],
    [null, false, 'new'],
  ]
)
// Once acked, a send shows once: from the log, not again from the outbox.
assert.equal(withPending(chat, [text(7, { cid: 'x3' })], outbox, uid).filter((m) => m.cid === 'x3').length, 1)

// The cursor stops at the first gap: entries past it (live ones that beat the repair) don't move it.
assert.equal(cursor([text(1), text(2), text(4)]), 2)

console.log('PASS: log rules')
