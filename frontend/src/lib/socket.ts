import type { QueryClient } from '@tanstack/react-query'
import { applyPatch, ServerFrame, type Message, type Patch } from 'backend/protocol'
import { WebSocket } from 'partysocket'
import { useSyncExternalStore } from 'react'
import { monotonicFactory } from 'ulid'
import * as v from 'valibot'

import { bumpInbox, inboxQuery, messagesQuery, outboxQuery, upsertMessages } from './api'
import { cursor, type LocalMessage, type Pending } from './log'
import { allOutbox, deleteOutbox, saveMessages, saveOutbox } from './store'

let socket: WebSocket | null = null
// Monotonic so two messages written in the same millisecond still sort, and replay, in the order they were written.
const ulid = monotonicFactory()
// Outbox writes and sends run one at a time, in the order they were made: a frame goes out only once it is in
// IndexedDB, so a reload can't lose it, and never ahead of an older unsent one (the replay on connect included).
let outbound: Promise<unknown> = Promise.resolve()
const queue = (work: () => Promise<unknown> | void) => {
  outbound = outbound.then(work).catch((error) => console.error(error))
}

/** `connecting` covers the first connect and every reconnect; `offline` is when the browser says there's no network. */
export type Connection = 'online' | 'connecting' | 'offline'
let connection: Connection = 'connecting'
const listeners = new Set<() => void>()

function setConnection(next: Connection) {
  if (next === connection) return
  connection = next
  listeners.forEach((l) => l())
}

export function useConnection() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => connection
  )
}

/** The wire frame of an outbox entry, without the local-only fields. */
const frame = (p: Pending) =>
  JSON.stringify(p, (key, value) => (key === 'failed' || key === 'local' ? undefined : value))

const setOutbox = (queryClient: QueryClient, update: (outbox: Pending[]) => Pending[]) =>
  queryClient.setQueryData<Pending[]>(outboxQuery.queryKey, (outbox) => outbox && update(outbox))

/** Puts an entry in the outbox and, once it is stored, sends it if connected. Offline, the next connect replays it. */
function enqueue(queryClient: QueryClient, p: Pending, andSend = true) {
  setOutbox(queryClient, (outbox) =>
    [...outbox.filter((q) => q.cid !== p.cid), p].sort((a, b) => (a.cid < b.cid ? -1 : 1))
  )
  queue(async () => {
    await saveOutbox(p)
    if (andSend && socket?.readyState === WebSocket.OPEN) socket.send(frame(p))
  })
}

function dequeue(queryClient: QueryClient, cid: string) {
  setOutbox(queryClient, (outbox) => outbox.filter((p) => p.cid !== cid))
  queue(() => deleteOutbox(cid))
}

/** Opens the device's single socket (held by the user's UserDO) and feeds frames into the cache and the store. */
export function connect(queryClient: QueryClient) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  // Derived from the facts on every event, since the socket and the browser's online/offline events race.
  const sync = () =>
    setConnection(!navigator.onLine ? 'offline' : ws.readyState === WebSocket.OPEN ? 'online' : 'connecting')
  for (const e of ['online', 'offline'] as const) window.addEventListener(e, sync)
  ws.addEventListener('close', sync)

  ws.addEventListener('open', () => {
    sync()
    // Anything unsent, from this session or an earlier one, goes again in the order it was written, except what the
    // server refused, which waits for Retry. Resending what the server already has is harmless: it dedupes on `cid`.
    queue(async () => {
      for (const p of await allOutbox()) if (!p.failed) ws.send(frame(p))
    })
    // Catch up on whatever was written while connecting or away, the first connect included: the inbox, and every
    // chat on screen. Chats not on screen sync when opened.
    void queryClient.invalidateQueries({ predicate: ({ queryKey: [k] }) => k === 'inbox' || k === 'messages' })
  })

  ws.addEventListener('message', (event) => {
    const parsed = v.safeParse(ServerFrame, JSON.parse(event.data))
    if (!parsed.success) return
    const f = parsed.output
    switch (f.t) {
      case 'ack':
      case 'msg':
        receive(queryClient, f.msg)
        break
      case 'error':
        if (f.cid) refused(queryClient, f.cid)
        break
    }
  })

  socket = ws
  return () => {
    for (const e of ['online', 'offline'] as const) window.removeEventListener(e, sync)
    ws.close()
    socket = null
  }
}

function receive(queryClient: QueryClient, msg: Message) {
  const { queryKey } = messagesQuery(msg.chat)
  const held = queryClient.getQueryData(queryKey)
  upsertMessages(queryClient, msg.chat, [msg])
  // Stored, so no longer pending; this socket's own copy can beat the ack. saveMessages clears it from IndexedDB.
  setOutbox(queryClient, (outbox) => outbox.filter((p) => p.cid !== msg.cid))
  void saveMessages(msg.chat, [msg])
  // A message past a gap shows right away; the gap is fetched now if the chat is on screen, or when it next opens.
  const hi = held && cursor(held)
  if (hi !== undefined && msg.seq > hi + 1) void queryClient.invalidateQueries({ queryKey })
  if (!bumpInbox(queryClient, msg)) void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey })
}

/** Sends a message optimistically. It goes to the outbox first, so it survives a reload or going offline. */
export function sendMessage(
  queryClient: QueryClient,
  chat: string,
  sender: string,
  body: string,
  replyTo?: LocalMessage
) {
  const cid = ulid()
  const reply = replyTo?.seq ? { seq: replyTo.seq, sender: replyTo.sender, body: replyTo.body.slice(0, 200) } : null
  const local: LocalMessage = {
    chat,
    cid,
    sender,
    body,
    reply,
    seq: null,
    ts: Date.now(),
    kind: 'text',
    target: null,
    edited: null,
    deleted: false,
    reactions: {},
    rev: 0,
  }
  enqueue(queryClient, { t: 'send', chat, cid, body, reply: reply?.seq, local })
}

/** Edits, deletes or reacts to a message: shown at once, sent through the outbox like a message. */
export function patchMessage(
  queryClient: QueryClient,
  uid: string,
  target: LocalMessage,
  change: { t: 'edit'; body: string } | { t: 'delete' } | { t: 'react'; emoji: string | null }
) {
  if (target.seq === null) return
  const pending: Patch = { ...change, cid: ulid(), chat: target.chat, seq: target.seq }
  if (typeof applyPatch(target, pending, uid, Date.now()) === 'string') return
  enqueue(queryClient, pending)
}

const pendingFor = (queryClient: QueryClient, cid: string) =>
  queryClient.getQueryData<Pending[]>(outboxQuery.queryKey)?.find((p) => p.cid === cid)

/** Sends a message the server refused once more. */
export function retryMessage(queryClient: QueryClient, message: LocalMessage) {
  const pending = pendingFor(queryClient, message.cid)
  if (pending) enqueue(queryClient, { ...pending, failed: false })
}

/** Drops a message that was never sent. */
export function discardMessage(queryClient: QueryClient, message: LocalMessage) {
  dequeue(queryClient, message.cid)
}

/**
 * The server refused a frame for good. A message stays, marked "Not sent", for Retry or Delete. A change is dropped,
 * which shows the message at its last confirmed state again.
 */
function refused(queryClient: QueryClient, cid: string) {
  const pending = pendingFor(queryClient, cid)
  if (pending?.t === 'send') enqueue(queryClient, { ...pending, failed: true }, false)
  else if (pending) dequeue(queryClient, cid)
}
