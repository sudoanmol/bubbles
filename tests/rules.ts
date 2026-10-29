// Checks the pure log rules every copy of a chat must agree on: `pnpm test`.
// Entries arrive twice, late, stale and out of order; the result must not depend on any of that.

import assert from 'node:assert/strict'

import {
  applyPatch,
  EDIT_WINDOW_MS,
  nextGroup,
  nextPreview,
  nextRead,
  type Message,
  type GroupEvent,
  type ReadState,
  type Text,
} from '../backend/src/protocol.ts'
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
const edited = { seq: 1, kind: 'text', sender: 'a', body: 'edited', deleted: false, rev: 2 }
assert.deepEqual(previewOf([text(1), patch(2, 1, { body: 'edited' })]), edited)
assert.deepEqual(
  previewOf([text(1), patch(2, 1, { body: 'edited' }), text(1), patch(2, 1, { body: 'edited' })]),
  edited
)
assert.deepEqual(previewOf([text(1), text(3), patch(2, 1, { body: 'edited' })]), {
  seq: 3,
  kind: 'text',
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
  // Message 4 was just sent, so it is still inside the edit window.
  [text(1), text(4, { ts: Date.now() })],
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

// Unread counts: a message from someone else counts once, however often it's delivered; patches never count; a
// message you send means you've read everything before it.
const readAfter = (ms: Message[], from: ReadState = { lastSeq: 0, readSeq: 0, unread: 0 }) =>
  ms.reduce((s, m) => nextRead(s, m, 'a'), from)
const fromB = [text(1, { sender: 'b' }), text(2, { sender: 'b' })]
assert.deepEqual(readAfter([...fromB, ...fromB, patch(3, 1, { body: 'x' })]), { lastSeq: 3, readSeq: 0, unread: 2 })
assert.deepEqual(readAfter([...fromB, text(3), fromB[0]]), { lastSeq: 3, readSeq: 3, unread: 0 })
// Read up to 1 already (a receipt beat the delivery): only 2 is unread.
assert.equal(readAfter(fromB, { lastSeq: 0, readSeq: 1, unread: 0 }).unread, 1)

// Edits close 15 minutes after sending; deletes and reactions don't.
const edit = { t: 'edit', cid: 'e', chat, seq: 1, body: 'late' } as const
assert.equal(typeof applyPatch(text(1), edit, 'a', 1 + EDIT_WINDOW_MS), 'object')
assert.equal(typeof applyPatch(text(1), edit, 'a', 2 + EDIT_WINDOW_MS), 'string')
assert.equal(typeof applyPatch(text(1), { ...edit, t: 'delete' }, 'a', 2 + EDIT_WINDOW_MS), 'object')

// A group's name and your place in it follow its events: removal takes you out, being added back puts you in (with any rename you missed), and
// someone else leaving changes nothing for you. Group events never count as unread.
const event = (seq: number, e: GroupEvent): Message => ({ ...text(seq, { body: JSON.stringify(e) }), kind: 'system' })
const by = { id: 'b', name: 'Bo' }
const me = { id: 'a', name: 'Al' }
const events = [
  event(1, { t: 'created', by, name: 'Climbers' }),
  event(2, { t: 'renamed', by, name: 'Friday climbers' }),
  event(3, { t: 'removed', by, user: me }),
]
const groupAfter = (ms: Message[]) => ms.reduce((s, m) => nextGroup(s, m, 'a'), { name: '', active: true })
assert.deepEqual(groupAfter(events), { name: 'Friday climbers', active: false })
assert.deepEqual(
  groupAfter([
    event(3, { t: 'removed', by, user: me }),
    event(4, { t: 'added', by, users: [me], name: 'Friday climbers' }),
  ]),
  { name: 'Friday climbers', active: true }
)
assert.deepEqual(groupAfter([event(5, { t: 'left', by })]).active, true)
assert.equal(readAfter(events).unread, 0)

console.log('PASS: log rules')
