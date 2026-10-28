import { queryOptions, type QueryClient } from '@tanstack/react-query'
import {
  nextPreview,
  nextRead,
  type Chat,
  type InboxItem,
  type Message,
  type Profile,
  type ServerFrame,
} from 'backend/protocol'

import { cursor, merge } from './log'
import {
  allOutbox,
  cachedChat,
  cachedInbox,
  cachedMessages,
  checkAccount,
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

/** This device's unsent frames, in write order. Shown on top of the log, never mixed into it. */
export const outboxQuery = queryOptions({
  queryKey: ['outbox'],
  queryFn: allOutbox,
  staleTime: Infinity,
  gcTime: Infinity,
})

export const inboxQuery = queryOptions({
  queryKey: ['inbox'],
  queryFn: async ({ client }) => {
    const uid = currentUid()
    const items = await api<InboxItem[]>('/inbox')
    checkAccount(uid)
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
      const uid = currentUid()
      const chat = await api<Chat>(`/chats/${id}`)
      checkAccount(uid)
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
    queryFn: async ({ client, queryKey }): Promise<Message[]> => {
      const uid = currentUid()
      const held = client.getQueryData<Message[]>(queryKey) ?? (await local(chat))
      const hi = cursor(held)
      const page = await api<Message[]>(`/chats/${chat}/messages${hi === undefined ? '' : `?after=${hi}`}`)
      checkAccount(uid)
      // More than a page behind: the server sent the latest page instead, so drop our older copy.
      const dropBefore = hi !== undefined && page.length > 0 && page[0].seq > hi + 1 ? page[0].seq : undefined
      void saveMessages(chat, page, dropBefore)
      // Read again: live messages may have arrived during the request.
      const now = client.getQueryData<Message[]>(queryKey) ?? held
      const kept = dropBefore === undefined ? now : now.filter((m) => m.seq >= dropBefore)
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

/** A chat's log as this device holds it. */
const local = async (chat: string) => merge([], await cachedMessages(chat, 2 * PAGE))

/**
 * Applies a read receipt: how far a member has read (shown as "Read" under your message), and for your own reads the
 * chat's unread count, so reading on one device clears it on all of them.
 */
export function applyRead(queryClient: QueryClient, f: Extract<ServerFrame, { t: 'read' }>) {
  queryClient.setQueryData<Chat>(chatQuery(f.chat).queryKey, (chat) => {
    if (!chat || (chat.reads[f.uid]?.seq ?? 0) > f.seq) return chat
    const updated = { ...chat, reads: { ...chat.reads, [f.uid]: { seq: f.seq, ts: f.ts } } }
    void saveChat(updated)
    return updated
  })
  if (f.unread === undefined) return
  const unread = f.unread
  setInboxItem(queryClient, f.chat, (item) => (item.readSeq > f.seq ? item : { ...item, readSeq: f.seq, unread }))
}

/** Clears a chat's unread count on this device at once, before the server confirms the read. */
export const clearUnread = (queryClient: QueryClient, chat: string) =>
  setInboxItem(queryClient, chat, (item) => (item.unread ? { ...item, unread: 0 } : item))

function setInboxItem(queryClient: QueryClient, chat: string, update: (item: InboxItem) => InboxItem) {
  queryClient.setQueryData<InboxItem[]>(inboxQuery.queryKey, (items) =>
    items?.map((item) => {
      if (item.chatId !== chat) return item
      const updated = update(item)
      if (updated !== item) void saveInboxItem(updated)
      return updated
    })
  )
}

/** Adds entries to a chat's cached log, if the chat is in the cache. */
export function upsertMessages(queryClient: QueryClient, chat: string, entries: Message[]) {
  queryClient.setQueryData<Message[]>(messagesQuery(chat).queryKey, (data) => data && merge(data, entries))
}

/**
 * Keeps the inbox in step with a live log entry, by the same rules as UserDO: a new message moves the chat to the top
 * as its preview and counts as unread unless it's yours; a change to the previewed message updates it. Returns false if the chat is not in the cache yet.
 */
export function bumpInbox(queryClient: QueryClient, msg: Message, uid: string) {
  let found = false
  queryClient.setQueryData<InboxItem[]>(inboxQuery.queryKey, (items) => {
    const item = items?.find((i) => i.chatId === msg.chat)
    if (!items || !item) return items
    found = true
    const preview = nextPreview(item.preview, msg)
    if (preview === item.preview && msg.seq <= item.lastSeq) return items
    const newer = preview !== null && preview.seq !== item.preview?.seq
    const updated = {
      ...item,
      ...nextRead(item, msg, uid),
      preview,
      updatedAt: newer ? msg.ts : item.updatedAt,
    }
    void saveInboxItem(updated)
    return newer ? [updated, ...items.filter((i) => i !== item)] : items.map((i) => (i === item ? updated : i))
  })
  return found
}
