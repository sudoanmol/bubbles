import { createServerFn } from '@tanstack/react-start'
import type {
  ChangeChatAdminRequest,
  ChatUser,
  CreateChatRequest,
  CreateChatResponse,
  DeleteMessageRequest,
  EditMessageRequest,
  GetChatByIdResponse,
  GetChatMessagesRequest,
  GetChatMessagesResponse,
  GetChatsResponse,
  ModifyChatMemberRequest,
  RenameChatRequest,
  SearchUsersRequest,
  SendMessageRequest,
} from '../types/chat'
import { useAppSession } from './session'
import { authenticatedFetch, getValidToken } from './utils'

export const getAuthTokenFn = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await useAppSession()
  return getValidToken(session)
})

export const searchUsersFn = createServerFn({ method: 'POST' })
  .validator((data: SearchUsersRequest) => data)
  .handler(async ({ data }) => {
    const result = await authenticatedFetch<ChatUser[]>(
      '/chat/search-users',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        retry_after: result.retry_after,
        users: [],
      }
    }

    if (!('data' in result) || !result.data) {
      return {
        success: false,
        error: 'Invalid server response',
        users: [],
      }
    }

    return { success: true, users: result.data }
  })

export const createChatFn = createServerFn({ method: 'POST' })
  .validator((data: CreateChatRequest) => data)
  .handler(async ({ data }) => {
    const result = await authenticatedFetch<CreateChatResponse>(
      '/chat/create',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )

    if (!result.success) {
      return { success: false, error: result.error }
    }

    if (!('data' in result) || !result.data) {
      return { success: false, error: 'Invalid server response' }
    }

    return { success: true, data: result.data }
  })

export const getUserChatsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const result = await authenticatedFetch<GetChatsResponse>(
    '/chat/all',
    { method: 'GET' },
    'Failed to connect to server'
  )

  if (!result.success) {
    return { success: false, error: result.error, chats: [] }
  }

  if (!('data' in result) || !result.data) {
    return { success: false, error: 'Invalid server response', chats: [] }
  }

  return { success: true, chats: result.data.chats }
})

export const getChatByIdFn = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const result = await authenticatedFetch<GetChatByIdResponse>(
      `/chat/${chatId}`,
      { method: 'GET' },
      'Failed to connect to server'
    )

    if (!result.success) {
      return { success: false, error: result.error }
    }

    if (!('data' in result) || !result.data) {
      return { success: false, error: 'Invalid server response' }
    }

    return { success: true, data: result.data }
  })

export const getChatMessagesFn = createServerFn({ method: 'POST' })
  .validator((data: GetChatMessagesRequest) => data)
  .handler(async ({ data }) => {
    const result = await authenticatedFetch<GetChatMessagesResponse>(
      '/messages/get',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )

    if (!result.success) {
      return { success: false, error: result.error, items: [] }
    }

    if (!('data' in result) || !result.data) {
      return { success: false, error: 'Invalid server response', items: [] }
    }

    return { success: true, ...result.data }
  })

export const sendMessageFn = createServerFn({ method: 'POST' })
  .validator((data: SendMessageRequest) => data)
  .handler(async ({ data }) => {
    const result = await authenticatedFetch<{ message_id: string }>(
      '/messages/send',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )

    if (!result.success) {
      return { success: false, error: result.error, retry_after: result.retry_after }
    }

    if (!('data' in result) || !result.data) {
      return { success: false, error: 'Invalid server response' }
    }

    return { success: true, message_id: result.data.message_id }
  })

export const editMessageFn = createServerFn({ method: 'POST' })
  .validator((data: EditMessageRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      '/messages/edit',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )
  })

export const deleteMessageFn = createServerFn({ method: 'POST' })
  .validator((data: DeleteMessageRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      '/messages/delete',
      {
        body: JSON.stringify(data),
      },
      'Failed to connect to server'
    )
  })

type ChatIdPayload = {
  chatId: string
}

export const clearChatFn = createServerFn({ method: 'POST' })
  .validator((data: ChatIdPayload) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(`/chat/${data.chatId}/clear`, {}, 'Failed to clear chat')
  })

export const deleteChatFn = createServerFn({ method: 'POST' })
  .validator((data: ChatIdPayload) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(`/chat/${data.chatId}/delete`, {}, 'Failed to delete chat')
  })

export const leaveChatFn = createServerFn({ method: 'POST' })
  .validator((data: ChatIdPayload) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(`/chat/${data.chatId}/leave`, {}, 'Failed to leave chat')
  })

export const renameChatFn = createServerFn({ method: 'POST' })
  .validator((data: RenameChatRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      `/chat/${data.chat_id}/rename`,
      {
        body: JSON.stringify({ name: data.name }),
      },
      'Failed to rename chat'
    )
  })

export const addChatMemberFn = createServerFn({ method: 'POST' })
  .validator((data: ModifyChatMemberRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      `/chat/${data.chat_id}/members/add`,
      {
        body: JSON.stringify({ user_id: data.user_id }),
      },
      'Failed to add member'
    )
  })

export const removeChatMemberFn = createServerFn({ method: 'POST' })
  .validator((data: ModifyChatMemberRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      `/chat/${data.chat_id}/members/remove`,
      {
        body: JSON.stringify({ user_id: data.user_id }),
      },
      'Failed to remove member'
    )
  })

export const changeChatAdminFn = createServerFn({ method: 'POST' })
  .validator((data: ChangeChatAdminRequest) => data)
  .handler(async ({ data }) => {
    return authenticatedFetch(
      `/chat/${data.chat_id}/change-admin`,
      {
        body: JSON.stringify({ user_id: data.user_id }),
      },
      'Failed to change admin'
    )
  })
