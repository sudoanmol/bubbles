import type { QueryClient } from '@tanstack/react-query'
import { applyPatch, ServerFrame, type Message, type Patch } from 'backend/protocol'
import { WebSocket } from 'partysocket'
import { useSyncExternalStore } from 'react'
import { monotonicFactory } from 'ulid'
import * as v from 'valibot'

import { bumpInbox, cursor, inboxQuery, messagesQuery, upsertMessage, type LocalMessage, type Pending } from './api'
import { allOutbox, cachedMessage, deleteOutbox, failOutbox, saveMessages, saveOutbox } from './store'

let socket: WebSocket | null = null
// Monotonic so two messages written in the same millisecond still sort, and replay, in the order they were written.
const ulid = monotonicFactory()
// The outbox replay of the current connection. New sends queue behind it so they never overtake older unsent ones.
let replayed: Promise<void> = Promise.resolve()

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

/** Sends now if connected; offline, the frame waits in the outbox for the next connect. */
const send = (p: Pending) =>
  void replayed.then(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame(p))
  })

/** Opens the device's single socket (held by the user's UserDO) and feeds frames into the cache and the store. */
export function connect(queryClient: QueryClient) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  let opened = false
  // Derived from the facts on every event, since the socket and the browser's online/offline events race.
  const sync = () =>
    setConnection(!navigator.onLine ? 'offline' : ws.readyState === WebSocket.OPEN ? 'online' : 'connecting')
  for (const e of ['online', 'offline'] as const) window.addEventListener(e, sync)
  ws.addEventListener('close', sync)

  ws.addEventListener('open', async () => {
    sync()
    // Anything unsent, from this session or an earlier one, goes again in the order it was written. Resending a
    // message the server already has is harmless: it dedupes on `cid` and acks again.
    replayed = allOutbox().then((outbox) => outbox.forEach((m) => ws.send(frame(m))))
    await replayed
    // After a reconnect, catch up: the inbox, and every chat on screen. Chats not on screen sync when opened.
    if (opened)
      void queryClient.invalidateQueries({ predicate: ({ queryKey: [k] }) => k === 'inbox' || k === 'messages' })
    opened = true
  })

  ws.addEventListener('message', (event) => {
    const parsed = v.safeParse(ServerFrame, JSON.parse(event.data))
    if (!parsed.success) return
    const f = parsed.output
    switch (f.t) {
      case 'ack':
        upsertMessage(queryClient, f.msg.chat, { ...f.msg, failed: false })
        void saveMessages(f.msg.chat, [f.msg])
        break
      case 'msg':
        receive(queryClient, f.msg)
        break
      case 'error':
        if (f.cid) void refused(queryClient, f.cid)
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
  upsertMessage(queryClient, msg.chat, msg)
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
  const pending: Pending = { t: 'send', chat, cid, body, reply: reply?.seq, local }
  upsertMessage(queryClient, chat, local)
  void saveOutbox(pending)
  send(pending)
}

/** Edits, deletes or reacts to a message: shown at once, sent through the outbox like a message. */
export function patchMessage(
  queryClient: QueryClient,
  uid: string,
  target: LocalMessage,
  change: Patch extends infer P ? (P extends Patch ? Omit<P, 'cid' | 'chat' | 'seq'> : never) : never
) {
  if (target.seq === null) return
  const pending = { ...change, cid: ulid(), chat: target.chat, seq: target.seq } as Patch
  const next = applyPatch(target, pending, uid, Date.now())
  if (typeof next === 'string') return
  upsertMessage(queryClient, target.chat, { cid: target.cid, ...next })
  void saveOutbox(pending)
  send(pending)
}

/** Sends a message the server refused once more. */
export function retryMessage(queryClient: QueryClient, message: LocalMessage) {
  const retried = { ...message, failed: false }
  const pending: Pending = {
    t: 'send',
    chat: message.chat,
    cid: message.cid,
    body: message.body,
    reply: message.reply?.seq,
    local: retried,
  }
  upsertMessage(queryClient, message.chat, retried)
  void saveOutbox(pending)
  send(pending)
}

/** Drops a message that was never sent. */
export function discardMessage(queryClient: QueryClient, message: LocalMessage) {
  queryClient.setQueryData<LocalMessage[]>(messagesQuery(message.chat).queryKey, (data) =>
    data?.filter((m) => m.cid !== message.cid)
  )
  void deleteOutbox(message.cid)
}

/**
 * The server refused a frame. A message stays, marked "Not sent", for Retry or Delete. A change is dropped and the
 * message goes back to the last state the server confirmed.
 */
async function refused(queryClient: QueryClient, cid: string) {
  const pending = await failOutbox(cid)
  if (!pending) return
  if (pending.t === 'send') return upsertMessage(queryClient, pending.chat, { cid, failed: true })
  // ponytail: a change refused for a passing reason (the chat was briefly unreachable) is dropped too; retry it if
  // that turns out to happen.
  void deleteOutbox(cid)
  const confirmed = await cachedMessage(pending.chat, pending.seq)
  if (confirmed) upsertMessage(queryClient, pending.chat, confirmed)
}
