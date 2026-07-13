export type ChatUser = {
  id: string
  username: string
  profile_image_url?: string | null
}

export type ChatMember = {
  id: string
  username: string
  profile_image_url?: string | null
}

export type MessageSender = {
  id: string
  username: string
  profile_image_url?: string | null
}

export type LastMessage = {
  id: string
  content?: string
  sender?: MessageSender
  is_deleted: boolean
  images: string[]
  created_at: string
}

export type SearchUsersRequest = {
  query: string
  selected_user_ids: string[]
}

export type CreateChatRequest = {
  member_ids: string[]
  group_name?: string
}

export type CreateChatResponse = {
  chat_id: string
  existing: boolean
}

export type ChatInfo = {
  id: string
  name?: string
  is_group: boolean
  creator_id: string
  members: ChatMember[]
  unread_count: number
  last_message?: LastMessage
  created_at: string
  updated_at: string
}

export type GetChatsResponse = {
  chats: ChatInfo[]
}

export type Message = {
  id: string
  content?: string
  sender_id: string
  sender_username: string
  sender_profile_image_url?: string | null
  is_deleted: boolean
  is_edited: boolean
  images: string[]
  created_at: string
  reply_to?: ReplyToMessage
}

export type ChatReadReceipt = {
  user_id: string
  last_read_message_id: string
  last_read_at: string
}

export type ReplyToMessage = {
  id: string
  sender_id: string
  sender_username: string
  sender_profile_image_url?: string | null
  content?: string
  images: string[]
  is_deleted: boolean
}

export type GetChatByIdResponse = {
  id: string
  name?: string
  is_group: boolean
  creator_id: string
  members: ChatMember[]
  created_at: string
  updated_at: string
}

export type GetChatMessagesRequest = {
  chat_id: string
  limit: number
  cursor?: {
    sent_at: string
    id: string
  }
}

export type GetChatMessagesResponse = {
  items: Message[]
  read_receipts: ChatReadReceipt[]
  next_cursor?: {
    sent_at: string
    id: string
  }
}

export type SendMessageRequest = {
  chat_id: string
  content: string
  images?: string[]
  reply_to_message_id?: string
}

export type EditMessageRequest = {
  message_id: string
  content: string
  removed_images?: string[]
}

export type DeleteMessageRequest = {
  message_id: string
}

export type RenameChatRequest = {
  chat_id: string
  name: string
}

export type ModifyChatMemberRequest = {
  chat_id: string
  user_id: string
}

export type ChangeChatAdminRequest = {
  chat_id: string
  user_id: string
}
