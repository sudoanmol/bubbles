package websocket

import "time"

type EventType string

const (
	EventMessageSent    EventType = "message_sent"
	EventMessageEdited  EventType = "message_edited"
	EventMessageDeleted EventType = "message_deleted"
	EventMessageRead    EventType = "message_read"
	EventTypingStart    EventType = "typing_start"
	EventTypingStop     EventType = "typing_stop"
	EventJoinChat       EventType = "join_chat"
	EventLeaveChat      EventType = "leave_chat"
	EventChatCreated    EventType = "chat_created"
	EventChatRemoved    EventType = "chat_removed"
)

type WSMessage struct {
	Type    EventType   `json:"type"`
	Payload interface{} `json:"payload"`
}

type MessageSentPayload struct {
	ID             string        `json:"id"`
	ChatID         string        `json:"chat_id"`
	SenderID       string        `json:"sender_id"`
	SenderUsername string        `json:"sender_username"`
	Content        *string       `json:"content,omitempty"`
	Images         []string      `json:"images"`
	IsDeleted      bool          `json:"is_deleted"`
	IsEdited       bool          `json:"is_edited"`
	CreatedAt      time.Time     `json:"created_at"`
	ReplyTo        *ReplyMessage `json:"reply_to,omitempty"`
}

type MessageEditedPayload struct {
	ID        string    `json:"id"`
	ChatID    string    `json:"chat_id"`
	Content   *string   `json:"content,omitempty"`
	Images    []string  `json:"images"`
	IsEdited  bool      `json:"is_edited"`
	UpdatedAt time.Time `json:"updated_at"`
}

type MessageDeletedPayload struct {
	ID        string `json:"id"`
	ChatID    string `json:"chat_id"`
	IsDeleted bool   `json:"is_deleted"`
}

type MessageReadPayload struct {
	ChatID            string    `json:"chat_id"`
	UserID            string    `json:"user_id"`
	LastReadMessageID string    `json:"last_read_message_id"`
	LastReadAt        time.Time `json:"last_read_at"`
}

type ReplyMessage struct {
	ID             string   `json:"id"`
	SenderID       string   `json:"sender_id"`
	SenderUsername string   `json:"sender_username"`
	Content        *string  `json:"content,omitempty"`
	Images         []string `json:"images"`
	IsDeleted      bool     `json:"is_deleted"`
}

type TypingPayload struct {
	ChatID   string `json:"chat_id"`
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

type ChatEventPayload struct {
	ChatID string `json:"chat_id"`
}

type ClientMessage struct {
	Type    EventType `json:"type"`
	Payload struct {
		ChatID    string `json:"chat_id"`
		MessageID string `json:"message_id,omitempty"`
	} `json:"payload"`
}
