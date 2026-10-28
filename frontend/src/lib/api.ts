import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { Chat, InboxItem, Message, MessagePage, Profile } from 'backend/protocol'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Something went wrong')
  return data as T
}

export const inboxQuery = queryOptions({
  queryKey: ['inbox'],
  queryFn: () => api<InboxItem[]>('/inbox'),
})

export const chatQuery = (id: string) =>
  queryOptions({ queryKey: ['chat', id], queryFn: () => api<Chat>(`/chats/${id}`), staleTime: Infinity })

/** A message as the client sees it: `seq` is null until the server acks it. */
export type LocalMessage = Omit<Message, 'seq'> & { seq: number | null; failed?: boolean }
export type Messages = { messages: LocalMessage[]; hasOlder: boolean }

export const messagesQuery = (id: string) =>
  queryOptions({
    queryKey: ['messages', id],
    queryFn: () => api<MessagePage>(`/chats/${id}/messages`) as Promise<Messages>,
    staleTime: Infinity,
  })

export const searchUsersQuery = (q: string) =>
  queryOptions({
    queryKey: ['users', q],
    queryFn: () => api<Profile[]>(`/users?q=${encodeURIComponent(q)}`),
    staleTime: 30_000,
  })

export const openDm = (username: string) => api<{ chatId: string }>(`/dms/${username}`, { method: 'POST' })

/** Inserts or replaces a message by `cid`, keeping acked messages in `seq` order and pending ones last. */
export function upsertMessage(queryClient: QueryClient, chat: string, msg: Partial<LocalMessage> & { cid: string }) {
  queryClient.setQueryData<Messages>(messagesQuery(chat).queryKey, (data) => {
    if (!data) return data
    const prev = data.messages.find((m) => m.cid === msg.cid)
    if (!prev && msg.body === undefined) return data
    const next = { ...prev, ...msg } as LocalMessage
    const messages = data.messages.filter((m) => m.cid !== msg.cid)
    messages.push(next)
    messages.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity))
    return { ...data, messages }
  })
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
    return [updated, ...items.filter((i) => i !== item)]
  })
  return found
}
