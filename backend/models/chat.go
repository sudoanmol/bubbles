package models

import (
	"time"

	"github.com/google/uuid"
)

type SearchUsersRequest struct {
	Query           string      `json:"query" binding:"required"`
	SelectedUserIds []uuid.UUID `json:"selected_user_ids"`
}

type SearchUsersResponse struct {
	ID              uuid.UUID `json:"id"`
	Username        string    `json:"username"`
	ProfileImageURL *string   `json:"profile_image_url,omitempty"`
}

type CreateChatRequest struct {
	MemberIds []uuid.UUID `json:"member_ids" binding:"required,min=2"`
	GroupName string      `json:"group_name"`
}

type CreateChatResponse struct {
	ChatID   uuid.UUID `json:"chat_id"`
	Existing bool      `json:"existing"`
}

type ChatMember struct {
	ID              uuid.UUID `json:"id"`
	Username        string    `json:"username"`
	ProfileImageURL *string   `json:"profile_image_url,omitempty"`
}

type MessageSender struct {
	ID              uuid.UUID `json:"id"`
	Username        string    `json:"username"`
	ProfileImageURL *string   `json:"profile_image_url,omitempty"`
}

type LastMessage struct {
	ID        uuid.UUID      `json:"id"`
	Content   *string        `json:"content,omitempty"`
	Sender    *MessageSender `json:"sender,omitempty"`
	IsDeleted bool           `json:"is_deleted"`
	Images    []string       `json:"images"`
	CreatedAt time.Time      `json:"created_at"`
}

type ChatInfo struct {
	ID          uuid.UUID    `json:"id"`
	Name        *string      `json:"name,omitempty"`
	IsGroup     bool         `json:"is_group"`
	CreatorID   uuid.UUID    `json:"creator_id"`
	Members     []ChatMember `json:"members"`
	UnreadCount int32        `json:"unread_count"`
	LastMessage *LastMessage `json:"last_message,omitempty"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

type GetChatsResponse struct {
	Chats []ChatInfo `json:"chats"`
}

type Message struct {
	ID                    uuid.UUID       `json:"id"`
	Content               *string         `json:"content,omitempty"`
	SenderID              uuid.UUID       `json:"sender_id"`
	SenderUsername        string          `json:"sender_username"`
	SenderProfileImageUrl *string         `json:"sender_profile_image_url,omitempty"`
	IsDeleted             bool            `json:"is_deleted"`
	IsEdited              bool            `json:"is_edited"`
	Images                []string        `json:"images"`
	CreatedAt             time.Time       `json:"created_at"`
	ReplyTo               *ReplyToMessage `json:"reply_to,omitempty"`
}

type ChatReadReceipt struct {
	UserID            uuid.UUID `json:"user_id"`
	LastReadMessageID uuid.UUID `json:"last_read_message_id"`
	LastReadAt        time.Time `json:"last_read_at"`
}

type ReplyToMessage struct {
	ID                    uuid.UUID `json:"id"`
	SenderID              uuid.UUID `json:"sender_id"`
	SenderUsername        string    `json:"sender_username"`
	SenderProfileImageUrl *string   `json:"sender_profile_image_url,omitempty"`
	Content               *string   `json:"content,omitempty"`
	Images                []string  `json:"images"`
	IsDeleted             bool      `json:"is_deleted"`
}

type GetChatByIdResponse struct {
	ID        uuid.UUID    `json:"id"`
	Name      *string      `json:"name,omitempty"`
	IsGroup   bool         `json:"is_group"`
	CreatorID uuid.UUID    `json:"creator_id"`
	Members   []ChatMember `json:"members"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
}

type GetChatMessagesRequest struct {
	ChatID string `json:"chat_id" binding:"required"`
	Limit  int    `json:"limit"`
	Cursor *struct {
		SentAt time.Time `json:"sent_at"`
		ID     uuid.UUID `json:"id"`
	} `json:"cursor,omitempty"`
}

type GetChatMessagesResponse struct {
	Items        []Message         `json:"items"`
	ReadReceipts []ChatReadReceipt `json:"read_receipts"`
	NextCursor   *struct {
		SentAt time.Time `json:"sent_at"`
		ID     uuid.UUID `json:"id"`
	} `json:"next_cursor,omitempty"`
}

type SendMessageRequest struct {
	ChatID           string   `json:"chat_id" binding:"required"`
	Content          string   `json:"content"`
	Images           []string `json:"images,omitempty"`
	ReplyToMessageID *string  `json:"reply_to_message_id"`
}

type EditMessageRequest struct {
	MessageID     string   `json:"message_id" binding:"required"`
	Content       string   `json:"content"`
	RemovedImages []string `json:"removed_images,omitempty"`
}

type DeleteMessageRequest struct {
	MessageID string `json:"message_id" binding:"required"`
}

type RenameChatRequest struct {
	Name string `json:"name" binding:"required"`
}

type ModifyChatMemberRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

type ChangeChatAdminRequest struct {
	UserID string `json:"user_id" binding:"required"`
}
