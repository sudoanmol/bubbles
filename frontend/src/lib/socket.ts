import type { QueryClient } from '@tanstack/react-query'
import { ServerFrame, type ClientFrame } from 'backend/protocol'
import { WebSocket } from 'partysocket'
import { ulid } from 'ulid'
import * as v from 'valibot'

import { bumpInbox, inboxQuery, upsertMessage } from './api'

let socket: WebSocket | null = null

/** Opens the device's single socket (held by the user's UserDO) and feeds frames into the query cache. */
export function connect(queryClient: QueryClient) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  let opened = false

  ws.addEventListener('open', () => {
    // ponytail: refetches everything after a reconnect; phase 2 replaces this with per-chat seq gap repair.
    if (opened) void queryClient.invalidateQueries()
    opened = true
  })

  ws.addEventListener('message', (event) => {
    const parsed = v.safeParse(ServerFrame, JSON.parse(event.data))
    if (!parsed.success) return
    const frame = parsed.output
    switch (frame.t) {
      case 'ack':
        upsertMessage(queryClient, frame.chat, { cid: frame.cid, seq: frame.seq, ts: frame.ts })
        break
      case 'msg':
        upsertMessage(queryClient, frame.msg.chat, frame.msg)
        if (!bumpInbox(queryClient, frame.msg)) void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey })
        break
      case 'error':
        if (frame.cid) markFailed(queryClient, frame.cid)
        break
    }
  })

  socket = ws
  return () => {
    ws.close()
    socket = null
  }
}

/** Sends a message optimistically: it shows as pending until the server acks it. */
export function sendMessage(queryClient: QueryClient, chat: string, sender: string, body: string) {
  const cid = ulid()
  upsertMessage(queryClient, chat, { chat, cid, sender, body, seq: null, ts: Date.now() })
  // partysocket queues frames while it reconnects.
  socket?.send(JSON.stringify({ t: 'send', chat, cid, body } satisfies ClientFrame))
}

function markFailed(queryClient: QueryClient, cid: string) {
  for (const [key] of queryClient.getQueriesData({ queryKey: ['messages'] })) {
    upsertMessage(queryClient, key[1] as string, { cid, failed: true })
  }
}
