import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { applyPatch, type Chat, type ClientFrame, type InboxItem, type Message, type Profile } from 'backend/protocol'

import {
  cachedChat,
  cachedInbox,
  cachedMessages,
  currentUid,
  saveChat,
  saveInbox,
  saveInboxItem,
  saveMessages,
} from './store'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Something went wrong')
  return data as T
}

/** Page size of the history API (ChatDO's PAGE). */
export const PAGE = 50

/** A log entry as the client sees it: `seq` is null until the server acks it. */
export type LocalMessage = Omit<Message, 'seq'> & { seq: number | null; failed?: boolean }

/** An outbox entry: a frame the server has not acked. A send keeps the message to show meanwhile. */
export type Pending = ClientFrame & { failed?: boolean; local?: LocalMessage }

/** The held log with this device's unsent frames on top: sends as pending messages, changes applied. */
export function withPending(messages: LocalMessage[], pending: Pending[], uid: string) {
  let out = messages
  for (const p of pending) {
    if (p.t === 'send') out = merge(out, [{ ...p.local!, failed: p.failed }])
    else {
      const target = out.find((m) => m.seq === p.seq && m.kind === 'text')
      const next = target && applyPatch(target, p, uid, Date.now())
      if (next && typeof next !== 'string') out = merge(out, [{ cid: target.cid, ...next }])
    }
  }
  return out
}

export const inboxQuery = queryOptions({
  queryKey: ['inbox'],
  queryFn: async ({ client }) => {
    const items = await api<InboxItem[]>('/inbox')
    // A live message can land while this request is in flight; keep whichever copy of a chat is newer.
    const live = new Map(client.getQueryData<InboxItem[]>(['inbox'])?.map((i) => [i.chatId, i]))
    const merged = items
      .map((i) => {
        const cur = live.get(i.chatId)
        return cur && cur.lastSeq > i.lastSeq ? cur : i
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    void saveInbox(merged)
    return merged
  },
})

export const chatQuery = (id: string) =>
  queryOptions({
    queryKey: ['chat', id],
    queryFn: async () => {
      const chat = await api<Chat>(`/chats/${id}`)
      void saveChat(chat)
      return chat
    },
    staleTime: Infinity,
  })

/**
 * A chat's messages. Fetching means syncing: ask for everything after our cursor and merge it in. Data is always
 * stale, so every mount, focus and invalidation (reconnect, a gap) re-syncs; when nothing is missing that's one
 * request that returns [].
 */
export const messagesQuery = (chat: string) =>
  queryOptions({
    queryKey: ['messages', chat],
    queryFn: async ({ client, queryKey }): Promise<LocalMessage[]> => {
      const held = client.getQueryData<LocalMessage[]>(queryKey) ?? (await local(chat))
      const hi = cursor(held)
      const page = await api<Message[]>(`/chats/${chat}/messages${hi === undefined ? '' : `?after=${hi}`}`)
      // More than a page behind: the server sent the latest page instead, so drop our older copy.
      const dropBefore = hi !== undefined && page.length > 0 && page[0].seq > hi + 1 ? page[0].seq : undefined
      void saveMessages(chat, page, dropBefore)
      // Read again: live messages may have arrived during the request.
      const now = client.getQueryData<LocalMessage[]>(queryKey) ?? held
      const kept = dropBefore === undefined ? now : now.filter((m) => m.seq === null || m.seq >= dropBefore)
      return merge(kept, page)
    },
  })

export const searchUsersQuery = (q: string) =>
  queryOptions({
    queryKey: ['users', q],
    queryFn: () => api<Profile[]>(`/users?q=${encodeURIComponent(q)}`),
    staleTime: 30_000,
  })

export const openDm = (username: string) => api<{ chatId: string }>(`/dms/${username}`, { method: 'POST' })

/** Puts the inbox from the local copy into the cache, so the sidebar renders before the network answers. */
export async function hydrateInbox(queryClient: QueryClient) {
  if (queryClient.getQueryData(inboxQuery.queryKey)) return
  const items = await cachedInbox()
  if (items.length && !queryClient.getQueryData(inboxQuery.queryKey))
    queryClient.setQueryData(inboxQuery.queryKey, items)
}

/** Same for one chat: its members and newest messages. The messages query then syncs in the background. */
export async function hydrateChat(queryClient: QueryClient, id: string) {
  const chatKey = chatQuery(id).queryKey
  const { queryKey } = messagesQuery(id)
  const [chat, messages] = await Promise.all([
    queryClient.getQueryData(chatKey) ? undefined : cachedChat(id),
    queryClient.getQueryData(queryKey) ? [] : local(id),
  ])
  if (chat && !queryClient.getQueryData(chatKey)) queryClient.setQueryData(chatKey, chat)
  if (messages.length && !queryClient.getQueryData(queryKey)) queryClient.setQueryData(queryKey, messages)
}

/** A chat as this device holds it, unsent changes included. */
async function local(chat: string) {
  const [acked, pending] = await cachedMessages(chat, 2 * PAGE)
  return withPending(acked, pending, currentUid())
}

/**
 * The end of the unbroken run of acked messages, starting from the oldest one held: what to sync after. Messages
 * past a gap (live ones that beat the repair) don't move it.
 */
export function cursor(messages: LocalMessage[]) {
  let hi: number | undefined
  for (const m of messages) {
    if (m.seq === null) continue
    if (hi === undefined || m.seq === hi + 1) hi = m.seq
    else if (m.seq > hi + 1) break
  }
  return hi
}

/**
 * Merges by `cid`: acked entries in `seq` order, unsent ones after them in the order they were written. A copy of a
 * message never replaces a newer one (higher `rev`), and a patch updates the message it changed if that is held.
 */
export function merge(messages: LocalMessage[], incoming: (Partial<LocalMessage> & { cid: string })[]) {
  const byCid = new Map(messages.map((m) => [m.cid, m]))
  const bySeq = new Map(messages.flatMap((m) => (m.seq === null ? [] : [[m.seq, m.cid]])))
  for (const m of incoming) {
    const prev = byCid.get(m.cid)
    // A partial update (an ack) for a message we don't hold has nothing to apply to.
    if (!prev && m.body === undefined) continue
    if (prev?.seq != null && m.rev !== undefined && prev.rev > m.rev) continue
    const next = { ...prev, ...m } as LocalMessage
    byCid.set(m.cid, next)
    if (next.seq !== null) bySeq.set(next.seq, next.cid)
    const target = next.kind === 'patch' && next.seq !== null && byCid.get(bySeq.get(next.target!) ?? '')
    if (target && next.seq! > target.rev) {
      const { body, reply, edited, deleted, reactions } = next
      byCid.set(target.cid, { ...target, body, reply, edited, deleted, reactions, rev: next.seq! })
    }
  }
  return [...byCid.values()].sort(
    (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0)
  )
}

/** Applies a change to a chat's cached messages, if the chat is in the cache. */
export function upsertMessage(queryClient: QueryClient, chat: string, msg: Partial<LocalMessage> & { cid: string }) {
  queryClient.setQueryData<LocalMessage[]>(messagesQuery(chat).queryKey, (data) => data && merge(data, [msg]))
}

/**
 * Keeps the inbox in step with a live log entry, as UserDO does: a new message moves the chat to the top as its
 * preview; a change to the previewed message updates the preview. Returns false if the chat is not in the cache yet.
 */
export function bumpInbox(queryClient: QueryClient, msg: Message) {
  let found = false
  queryClient.setQueryData<InboxItem[]>(inboxQuery.queryKey, (items) => {
    const item = items?.find((i) => i.chatId === msg.chat)
    if (!items || !item) return items
    found = true
    if (msg.seq <= item.lastSeq) return items
    if (msg.kind === 'patch') {
      const preview =
        item.preview?.seq === msg.target ? { ...item.preview, body: msg.body, deleted: msg.deleted } : item.preview
      const updated = { ...item, lastSeq: msg.seq, preview }
      void saveInboxItem(updated)
      return items.map((i) => (i === item ? updated : i))
    }
    const preview = { seq: msg.seq, sender: msg.sender, body: msg.body, deleted: false }
    const updated = { ...item, lastSeq: msg.seq, preview, updatedAt: msg.ts }
    void saveInboxItem(updated)
    return [updated, ...items.filter((i) => i !== item)]
  })
  return found
}
