package websocket

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/anmol7470/bubbles/backend/database"
	"github.com/google/uuid"
)

const (
	dbTimeout             = 5 * time.Second
	maxConnectionsPerUser = 8
)

type Hub struct {
	clients     map[*Client]bool
	userClients map[string]map[*Client]bool
	chatRooms   map[string]map[*Client]bool
	dbService   *database.Service
	mu          sync.RWMutex
}

func NewHub(dbService *database.Service) *Hub {
	return &Hub{
		clients:     make(map[*Client]bool),
		userClients: make(map[string]map[*Client]bool),
		chatRooms:   make(map[string]map[*Client]bool),
		dbService:   dbService,
	}
}

func dbContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), dbTimeout)
}

// RegisterClient adds the client to the hub. It returns false when the user
// already has too many open connections.
func (h *Hub) RegisterClient(client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.userClients[client.userID]) >= maxConnectionsPerUser {
		log.Printf("Connection limit reached: user_id=%s", client.userID)
		return false
	}

	h.clients[client] = true
	if h.userClients[client.userID] == nil {
		h.userClients[client.userID] = make(map[*Client]bool)
	}
	h.userClients[client.userID][client] = true

	log.Printf("Client registered: user_id=%s, total_clients=%d", client.userID, len(h.clients))
	return true
}

func (h *Hub) UnregisterClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client]; !ok {
		return
	}

	delete(h.clients, client)
	close(client.send)

	if userConns, ok := h.userClients[client.userID]; ok {
		delete(userConns, client)
		if len(userConns) == 0 {
			delete(h.userClients, client.userID)
		}
	}

	for chatID := range client.rooms {
		h.removeFromRoomLocked(client, chatID)
	}

	log.Printf("Client unregistered: user_id=%s, total_clients=%d", client.userID, len(h.clients))
}

func (h *Hub) removeFromRoomLocked(client *Client, chatID string) {
	delete(client.rooms, chatID)
	if room, ok := h.chatRooms[chatID]; ok {
		delete(room, client)
		if len(room) == 0 {
			delete(h.chatRooms, chatID)
		}
	}
}

func (h *Hub) ValidateMembership(userID, chatID string) bool {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		log.Printf("Invalid user ID: %s", userID)
		return false
	}

	chatUUID, err := uuid.Parse(chatID)
	if err != nil {
		log.Printf("Invalid chat ID: %s", chatID)
		return false
	}

	ctx, cancel := dbContext()
	defer cancel()

	isMember, err := h.dbService.Queries.IsChatMember(ctx, database.IsChatMemberParams{
		ChatID: chatUUID,
		UserID: userUUID,
	})

	if err != nil {
		log.Printf("Error checking chat membership: %v", err)
		return false
	}

	return isMember
}

// IsSubscribed reports whether the client has joined the chat room. Room
// membership is validated against the database at join time and kept in sync
// by the membership-change endpoints, so this is the source of truth for
// per-event authorization.
func (h *Hub) IsSubscribed(client *Client, chatID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return client.rooms[chatID]
}

func (h *Hub) SubscribeToChat(client *Client, chatID string) bool {
	h.mu.RLock()
	alreadySubscribed := client.rooms[chatID]
	h.mu.RUnlock()
	if alreadySubscribed {
		return true
	}

	if !h.ValidateMembership(client.userID, chatID) {
		log.Printf("Unauthorized subscription attempt: user_id=%s, chat_id=%s", client.userID, chatID)
		return false
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.chatRooms[chatID] == nil {
		h.chatRooms[chatID] = make(map[*Client]bool)
	}
	h.chatRooms[chatID][client] = true
	client.rooms[chatID] = true

	log.Printf("Client subscribed to chat: user_id=%s, chat_id=%s, chat_members=%d",
		client.userID, chatID, len(h.chatRooms[chatID]))
	return true
}

func (h *Hub) UnsubscribeFromChat(client *Client, chatID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.removeFromRoomLocked(client, chatID)

	log.Printf("Client unsubscribed from chat: user_id=%s, chat_id=%s", client.userID, chatID)
}

// EvictUserFromChat removes every connection of the user from the chat room
// and tells those connections the chat is gone, so removed members stop
// receiving events immediately instead of at their next reconnect.
func (h *Hub) EvictUserFromChat(userID, chatID string) {
	data, err := json.Marshal(WSMessage{
		Type:    EventChatRemoved,
		Payload: ChatEventPayload{ChatID: chatID},
	})
	if err != nil {
		log.Printf("Error marshaling chat_removed event: %v", err)
		data = nil
	}

	h.mu.Lock()
	var slow []*Client
	for client := range h.userClients[userID] {
		if client.rooms[chatID] {
			h.removeFromRoomLocked(client, chatID)
			if data != nil && !trySend(client, data) {
				slow = append(slow, client)
			}
		}
	}
	h.mu.Unlock()

	closeSlowClients(slow)
	log.Printf("Evicted user from chat: user_id=%s, chat_id=%s", userID, chatID)
}

// EvictAllFromChat notifies every subscriber that the chat was removed and
// deletes the room. Used when a chat is permanently deleted.
func (h *Hub) EvictAllFromChat(chatID string) {
	h.BroadcastToChat(chatID, WSMessage{
		Type:    EventChatRemoved,
		Payload: ChatEventPayload{ChatID: chatID},
	})

	h.mu.Lock()
	for client := range h.chatRooms[chatID] {
		delete(client.rooms, chatID)
	}
	delete(h.chatRooms, chatID)
	h.mu.Unlock()
}

// SendToUser delivers a message to every open connection of the user,
// regardless of room subscriptions.
func (h *Hub) SendToUser(userID string, message WSMessage) {
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Error marshaling message: %v", err)
		return
	}

	h.mu.RLock()
	var slow []*Client
	for client := range h.userClients[userID] {
		if !trySend(client, data) {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()

	closeSlowClients(slow)
}

func (h *Hub) BroadcastToChat(chatID string, message WSMessage) {
	h.BroadcastToChatExclude(chatID, message, "")
}

func (h *Hub) BroadcastToChatExclude(chatID string, message WSMessage, excludeUserID string) {
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Error marshaling message: %v", err)
		return
	}

	h.mu.RLock()
	clients, ok := h.chatRooms[chatID]
	if !ok {
		h.mu.RUnlock()
		return
	}

	sentCount := 0
	var slow []*Client
	for client := range clients {
		if excludeUserID != "" && client.userID == excludeUserID {
			continue
		}
		if trySend(client, data) {
			sentCount++
		} else {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()

	// A full send buffer means the client cannot keep up; closing the
	// connection forces a reconnect and refetch instead of silent message
	// loss.
	closeSlowClients(slow)

	log.Printf("Broadcast to chat: chat_id=%s, type=%s, sent_to=%d clients", chatID, message.Type, sentCount)
}

func trySend(client *Client, data []byte) bool {
	select {
	case client.send <- data:
		return true
	default:
		return false
	}
}

func closeSlowClients(clients []*Client) {
	for _, client := range clients {
		log.Printf("Client send buffer full, closing connection: user_id=%s", client.userID)
		client.conn.Close()
	}
}

func (h *Hub) BroadcastTyping(chatID string, eventType EventType, payload TypingPayload) {
	h.BroadcastToChatExclude(chatID, WSMessage{
		Type:    eventType,
		Payload: payload,
	}, payload.UserID)
}

// NotifyChatCreated tells each member's open connections that a chat now
// exists so they can join its room without waiting for a page reload.
func (h *Hub) NotifyChatCreated(chatID string, memberIDs []uuid.UUID) {
	for _, memberID := range memberIDs {
		h.SendToUser(memberID.String(), WSMessage{
			Type:    EventChatCreated,
			Payload: ChatEventPayload{ChatID: chatID},
		})
	}
}

func (h *Hub) HandleReadReceipt(client *Client, chatID, messageID string) {
	if !h.IsSubscribed(client, chatID) {
		log.Printf("Unauthorized read receipt attempt: user_id=%s, chat_id=%s", client.userID, chatID)
		return
	}

	userUUID, err := uuid.Parse(client.userID)
	if err != nil {
		log.Printf("Invalid user ID for read receipt: %s", client.userID)
		return
	}

	chatUUID, err := uuid.Parse(chatID)
	if err != nil {
		log.Printf("Invalid chat ID for read receipt: %s", chatID)
		return
	}

	messageUUID, err := uuid.Parse(messageID)
	if err != nil {
		log.Printf("Invalid message ID for read receipt: %s", messageID)
		return
	}

	ctx, cancel := dbContext()
	defer cancel()

	message, err := h.dbService.Queries.GetMessageById(ctx, messageUUID)
	if err != nil {
		log.Printf("Failed to load message for read receipt: %v", err)
		return
	}

	if message.ChatID != chatUUID {
		log.Printf("Read receipt message/chat mismatch: user_id=%s, chat_id=%s, message_id=%s",
			client.userID, chatID, messageID)
		return
	}

	err = h.dbService.Queries.UpsertChatReadReceipt(ctx, database.UpsertChatReadReceiptParams{
		ChatID:            chatUUID,
		UserID:            userUUID,
		LastReadMessageID: messageUUID,
		LastReadAt:        message.CreatedAt,
	})
	if err != nil {
		log.Printf("Failed to upsert read receipt: %v", err)
		return
	}

	// Broadcast to everyone, including the reader's other devices, so
	// unread badges stay in sync across tabs.
	h.BroadcastToChat(chatID, WSMessage{
		Type: EventMessageRead,
		Payload: MessageReadPayload{
			ChatID:            chatID,
			UserID:            client.userID,
			LastReadMessageID: messageID,
			LastReadAt:        message.CreatedAt,
		},
	})
}

// Shutdown closes every client connection so hijacked WebSocket connections
// terminate during graceful server shutdown.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for client := range h.clients {
		clients = append(clients, client)
	}
	h.mu.Unlock()

	for _, client := range clients {
		client.closeGracefully()
	}
}
