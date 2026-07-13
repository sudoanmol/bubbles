import { useWebSocket } from '@/contexts/websocket-context'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { ChatInfo, ChatReadReceipt, GetChatMessagesResponse, Message, ReplyToMessage } from '../types/chat'

type MessageSentPayload = {
  id: string
  chat_id: string
  sender_id: string
  sender_username: string
  content?: string
  images: string[]
  is_deleted: boolean
  is_edited: boolean
  created_at: string
  reply_to?: ReplyPayload
}

type ReplyPayload = {
  id: string
  sender_id: string
  sender_username: string
  content?: string
  images: string[]
  is_deleted: boolean
}

type MessageEditedPayload = {
  id: string
  chat_id: string
  content?: string
  images: string[]
  is_edited: boolean
  updated_at: string
}

type MessageDeletedPayload = {
  id: string
  chat_id: string
  is_deleted: boolean
}

type MessageReadPayload = {
  chat_id: string
  user_id: string
  last_read_message_id: string
  last_read_at: string
}

export function useChatWebSocket(chatId?: string) {
  const queryClient = useQueryClient()
  const { on } = useWebSocket()

  useEffect(() => {
    if (!chatId) return

    const unsubscribeSent = on('message_sent', (payload: MessageSentPayload) => {
      if (payload.chat_id !== chatId) return

      queryClient.setQueryData<{ pages: GetChatMessagesResponse[]; pageParams: any[] }>(
        ['messages', chatId],
        (oldData) => {
          if (!oldData) return oldData

          const newMessage: Message = {
            id: payload.id,
            content: payload.content,
            sender_id: payload.sender_id,
            sender_username: payload.sender_username,
            is_deleted: payload.is_deleted,
            is_edited: payload.is_edited,
            images: payload.images,
            created_at: payload.created_at,
            reply_to: payload.reply_to
              ? ({
                  id: payload.reply_to.id,
                  sender_id: payload.reply_to.sender_id,
                  sender_username: payload.reply_to.sender_username,
                  content: payload.reply_to.content,
                  images: payload.reply_to.images,
                  is_deleted: payload.reply_to.is_deleted,
                } satisfies ReplyToMessage)
              : undefined,
          }

          const firstPage = oldData.pages[0]
          if (!firstPage) return oldData

          const messageExists = firstPage.items.some((msg) => msg.id === newMessage.id)
          if (messageExists) return oldData

          return {
            ...oldData,
            pages: [
              {
                ...firstPage,
                items: [newMessage, ...firstPage.items],
              },
              ...oldData.pages.slice(1),
            ],
          }
        }
      )
    })

    const unsubscribeEdited = on('message_edited', (payload: MessageEditedPayload) => {
      if (payload.chat_id !== chatId) return

      queryClient.setQueryData<{ pages: GetChatMessagesResponse[]; pageParams: any[] }>(
        ['messages', chatId],
        (oldData) => {
          if (!oldData) return oldData

          return {
            ...oldData,
            pages: oldData.pages.map((page) => ({
              ...page,
              items: page.items.map((msg) =>
                msg.id === payload.id
                  ? {
                      ...msg,
                      content: payload.content,
                      images: payload.images,
                      is_edited: payload.is_edited,
                    }
                  : msg
              ),
            })),
          }
        }
      )
    })

    const unsubscribeDeleted = on('message_deleted', (payload: MessageDeletedPayload) => {
      if (payload.chat_id !== chatId) return

      queryClient.setQueryData<{ pages: GetChatMessagesResponse[]; pageParams: any[] }>(
        ['messages', chatId],
        (oldData) => {
          if (!oldData) return oldData

          return {
            ...oldData,
            pages: oldData.pages.map((page) => ({
              ...page,
              items: page.items.map((msg) =>
                msg.id === payload.id
                  ? {
                      ...msg,
                      is_deleted: payload.is_deleted,
                    }
                  : msg
              ),
            })),
          }
        }
      )
    })

    const unsubscribeRead = on('message_read', (payload: MessageReadPayload) => {
      if (payload.chat_id !== chatId) return

      queryClient.setQueryData<{ pages: GetChatMessagesResponse[]; pageParams: any[] }>(
        ['messages', chatId],
        (oldData) => {
          if (!oldData || !oldData.pages[0]) return oldData

          const firstPage = oldData.pages[0]
          const existingReceipts = firstPage.read_receipts ?? []
          const receiptIndex = existingReceipts.findIndex((receipt) => receipt.user_id === payload.user_id)
          const payloadTimestamp = new Date(payload.last_read_at).getTime()

          let updatedReceipts: ChatReadReceipt[]

          if (receiptIndex === -1) {
            updatedReceipts = [
              ...existingReceipts,
              {
                user_id: payload.user_id,
                last_read_message_id: payload.last_read_message_id,
                last_read_at: payload.last_read_at,
              } satisfies ChatReadReceipt,
            ]
          } else {
            const existing = existingReceipts[receiptIndex]
            const existingTimestamp = new Date(existing.last_read_at).getTime()
            if (existingTimestamp >= payloadTimestamp) {
              return oldData
            }

            updatedReceipts = [...existingReceipts]
            updatedReceipts[receiptIndex] = {
              user_id: payload.user_id,
              last_read_message_id: payload.last_read_message_id,
              last_read_at: payload.last_read_at,
            }
          }

          const updatedPages = [...oldData.pages]
          updatedPages[0] = {
            ...firstPage,
            read_receipts: updatedReceipts,
          }

          return {
            ...oldData,
            pages: updatedPages,
          }
        }
      )
    })

    return () => {
      unsubscribeSent()
      unsubscribeEdited()
      unsubscribeDeleted()
      unsubscribeRead()
    }
  }, [chatId, on, queryClient])
}

export function useChatListWebSocket(currentUserId?: string, currentlyViewedChatId?: string) {
  const queryClient = useQueryClient()
  const { on } = useWebSocket()

  useEffect(() => {
    const unsubscribeSent = on('message_sent', (payload: MessageSentPayload) => {
      // A message for a chat missing from the cache means a new or
      // resurrected chat; refetch the list so it appears.
      const cachedChats = queryClient.getQueryData<ChatInfo[]>(['chats'])
      if (cachedChats && !cachedChats.some((chat) => chat.id === payload.chat_id)) {
        queryClient.invalidateQueries({ queryKey: ['chats'] })
        return
      }

      queryClient.setQueryData<ChatInfo[]>(['chats'], (oldChats) => {
        if (!oldChats) return oldChats

        const chatIndex = oldChats.findIndex((chat) => chat.id === payload.chat_id)
        if (chatIndex === -1) return oldChats

        const existingChat = oldChats[chatIndex]
        const shouldIncrementUnread = Boolean(
          currentUserId && payload.sender_id !== currentUserId && payload.chat_id !== currentlyViewedChatId
        )
        const nextUnreadCount = shouldIncrementUnread
          ? (existingChat.unread_count ?? 0) + 1
          : (existingChat.unread_count ?? 0)

        const updatedChat = {
          ...existingChat,
          last_message: {
            id: payload.id,
            content: payload.content,
            sender: {
              id: payload.sender_id,
              username: payload.sender_username,
            },
            is_deleted: payload.is_deleted,
            images: payload.images,
            created_at: payload.created_at,
          },
          updated_at: payload.created_at,
          unread_count: shouldIncrementUnread ? nextUnreadCount : (existingChat.unread_count ?? 0),
        }

        const updatedChats = [...oldChats]
        updatedChats.splice(chatIndex, 1)
        updatedChats.unshift(updatedChat)

        return updatedChats
      })
    })

    const unsubscribeEdited = on('message_edited', (payload: MessageEditedPayload) => {
      queryClient.setQueryData<ChatInfo[]>(['chats'], (oldChats) => {
        if (!oldChats) return oldChats

        return oldChats.map((chat) => {
          if (chat.id === payload.chat_id && chat.last_message?.id === payload.id) {
            return {
              ...chat,
              last_message: {
                ...chat.last_message,
                content: payload.content,
                images: payload.images,
              },
            }
          }
          return chat
        })
      })
    })

    const unsubscribeDeleted = on('message_deleted', (payload: MessageDeletedPayload) => {
      queryClient.setQueryData<ChatInfo[]>(['chats'], (oldChats) => {
        if (!oldChats) return oldChats

        return oldChats.map((chat) => {
          if (chat.id === payload.chat_id && chat.last_message?.id === payload.id) {
            return {
              ...chat,
              last_message: {
                ...chat.last_message,
                is_deleted: payload.is_deleted,
              },
            }
          }
          return chat
        })
      })
    })

    const unsubscribeRead = on('message_read', (payload: MessageReadPayload) => {
      if (!currentUserId || payload.user_id !== currentUserId) return

      queryClient.setQueryData<ChatInfo[]>(['chats'], (oldChats) => {
        if (!oldChats) return oldChats

        return oldChats.map((chat) =>
          chat.id === payload.chat_id
            ? {
                ...chat,
                unread_count: 0,
              }
            : chat
        )
      })
    })

    return () => {
      unsubscribeSent()
      unsubscribeEdited()
      unsubscribeDeleted()
      unsubscribeRead()
    }
  }, [currentUserId, currentlyViewedChatId, on, queryClient])
}
