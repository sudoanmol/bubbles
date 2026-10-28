import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { Chat, InboxItem, Message, Profile } from 'backend/protocol'

import { cachedChat, cachedInbox, cachedMessages, saveChat, saveInbox, saveInboxItem, saveMessages } from './store'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Something went wrong')
  return data as T
}

/** Page size of the history API (ChatDO's PAGE). */
export const PAGE = 50

/** A message as the client sees it: `seq` is null until the server acks it. */
export type LocalMessage = Omit<Message, 'seq'> & { seq: number | null; failed?: boolean }

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
      const held = client.getQueryData<LocalMessage[]>(queryKey) ?? (await cachedMessages(chat, 2 * PAGE))
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
    queryClient.getQueryData(queryKey) ? [] : cachedMessages(id, 2 * PAGE),
  ])
  if (chat && !queryClient.getQueryData(chatKey)) queryClient.setQueryData(chatKey, chat)
  if (messages.length && !queryClient.getQueryData(queryKey)) queryClient.setQueryData(queryKey, messages)
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

/** Merges by `cid`: acked messages in `seq` order, unsent ones after them in the order they were written. */
export function merge(messages: LocalMessage[], incoming: (Partial<LocalMessage> & { cid: string })[]) {
  const byCid = new Map(messages.map((m) => [m.cid, m]))
  for (const m of incoming) {
    const prev = byCid.get(m.cid)
    // A partial update (an ack) for a message we don't hold has nothing to apply to.
    if (prev || m.body !== undefined) byCid.set(m.cid, { ...prev, ...m } as LocalMessage)
  }
  return [...byCid.values()].sort(
    (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0)
  )
}

/** Applies a change to a chat's cached messages, if the chat is in the cache. */
export function upsertMessage(queryClient: QueryClient, chat: string, msg: Partial<LocalMessage> & { cid: string }) {
  queryClient.setQueryData<LocalMessage[]>(messagesQuery(chat).queryKey, (data) => data && merge(data, [msg]))
}

/** Moves a chat to the top of the inbox with a new preview. Returns false if the chat is not in the cache yet. */
export function bumpInbox(queryClient: QueryClient, msg: Message) {
  let found = false
  queryClient.setQueryData<InboxItem[]>(inboxQuery.queryKey, (items) => {
    const item = items?.find((i) => i.chatId === msg.chat)
    if (!items || !item) return items
    found = true
    if (msg.seq <= item.lastSeq) return items
    const updated = { ...item, lastSeq: msg.seq, preview: { sender: msg.sender, body: msg.body }, updatedAt: msg.ts }
    void saveInboxItem(updated)
    return [updated, ...items.filter((i) => i !== item)]
  })
  return found
}
