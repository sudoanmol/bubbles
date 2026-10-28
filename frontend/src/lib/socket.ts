import type { QueryClient } from '@tanstack/react-query'
import { ServerFrame, type ClientFrame, type Message } from 'backend/protocol'
import { WebSocket } from 'partysocket'
import { ulid } from 'ulid'
import * as v from 'valibot'

import { bumpInbox, cursor, inboxQuery, messagesQuery, upsertMessage, type LocalMessage } from './api'
import { ackOutbox, allOutbox, failOutbox, saveMessages, saveOutbox } from './store'

let socket: WebSocket | null = null

const frame = (m: LocalMessage) =>
  JSON.stringify({ t: 'send', chat: m.chat, cid: m.cid, body: m.body } satisfies ClientFrame)

/** Opens the device's single socket (held by the user's UserDO) and feeds frames into the cache and the store. */
export function connect(queryClient: QueryClient) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  let opened = false

  ws.addEventListener('open', async () => {
    // Anything unsent, from this session or an earlier one, goes again in the order it was written. Resending a
    // message the server already has is harmless: it dedupes on `cid` and acks again.
    for (const m of await allOutbox()) ws.send(frame(m))
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
        upsertMessage(queryClient, f.chat, { cid: f.cid, seq: f.seq, ts: f.ts, failed: false })
        void ackOutbox(f.cid, f.seq, f.ts)
        break
      case 'msg':
        receive(queryClient, f.msg)
        break
      case 'error':
        if (f.cid) {
          markFailed(queryClient, f.cid)
          void failOutbox(f.cid)
        }
        break
    }
  })

  socket = ws
  return () => {
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
export function sendMessage(queryClient: QueryClient, chat: string, sender: string, body: string) {
  const message: LocalMessage = { chat, cid: ulid(), sender, body, seq: null, ts: Date.now() }
  upsertMessage(queryClient, chat, message)
  void saveOutbox(message)
  // Offline, it waits in the outbox and goes out on the next connect.
  if (socket?.readyState === WebSocket.OPEN) socket.send(frame(message))
}

function markFailed(queryClient: QueryClient, cid: string) {
  for (const [key] of queryClient.getQueriesData({ queryKey: ['messages'] })) {
    upsertMessage(queryClient, key[1] as string, { cid, failed: true })
  }
}
