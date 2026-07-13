package websocket

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4 * 1024

	// Token bucket for inbound events. The burst must cover a reconnecting
	// client joining all of its chats at once; the sustained rate only needs
	// to cover typing and read receipts.
	eventRateBurst  = 200
	eventRatePerSec = 20
)

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	userID   string
	username string
	// rooms is guarded by hub.mu.
	rooms map[string]bool

	tokens      float64
	lastRefill  time.Time
	expiryTimer *time.Timer
}

func NewClient(hub *Hub, conn *websocket.Conn, userID, username string) *Client {
	return &Client{
		hub:        hub,
		conn:       conn,
		send:       make(chan []byte, 256),
		userID:     userID,
		username:   username,
		rooms:      make(map[string]bool),
		tokens:     eventRateBurst,
		lastRefill: time.Now(),
	}
}

// allowEvent implements a token bucket; only called from ReadPump so no
// locking is needed.
func (c *Client) allowEvent() bool {
	now := time.Now()
	c.tokens += now.Sub(c.lastRefill).Seconds() * eventRatePerSec
	if c.tokens > eventRateBurst {
		c.tokens = eventRateBurst
	}
	c.lastRefill = now

	if c.tokens < 1 {
		return false
	}
	c.tokens--
	return true
}

func (c *Client) closeGracefully() {
	c.closeWithReason(websocket.CloseGoingAway, "server shutting down")
}

func (c *Client) closeWithReason(code int, reason string) {
	deadline := time.Now().Add(writeWait)
	c.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), deadline)
	c.conn.Close()
}

// CloseWhenTokenExpires closes the connection once the JWT that authenticated
// it expires, so an open socket cannot outlive its credentials. The client
// reconnects with a fresh token.
func (c *Client) CloseWhenTokenExpires(expiresAt time.Time) {
	c.expiryTimer = time.AfterFunc(time.Until(expiresAt), func() {
		log.Printf("Closing connection with expired token: user_id=%s", c.userID)
		c.closeWithReason(websocket.ClosePolicyViolation, "token expired")
	})
}

func (c *Client) ReadPump() {
	defer func() {
		if c.expiryTimer != nil {
			c.expiryTimer.Stop()
		}
		c.hub.UnregisterClient(c)
		c.conn.Close()
	}()

	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	c.conn.SetReadLimit(maxMessageSize)

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var clientMsg ClientMessage
		if err := json.Unmarshal(message, &clientMsg); err != nil {
			log.Printf("Error unmarshaling client message: %v", err)
			continue
		}

		if !c.allowEvent() {
			log.Printf("Rate limit exceeded, dropping event: user_id=%s, type=%s", c.userID, clientMsg.Type)
			continue
		}

		switch clientMsg.Type {
		case EventJoinChat:
			if !c.hub.SubscribeToChat(c, clientMsg.Payload.ChatID) {
				log.Printf("Failed to join chat: user_id=%s, chat_id=%s", c.userID, clientMsg.Payload.ChatID)
			}

		case EventLeaveChat:
			c.hub.UnsubscribeFromChat(c, clientMsg.Payload.ChatID)

		case EventTypingStart, EventTypingStop:
			if c.hub.IsSubscribed(c, clientMsg.Payload.ChatID) {
				c.hub.BroadcastTyping(clientMsg.Payload.ChatID, clientMsg.Type, TypingPayload{
					ChatID:   clientMsg.Payload.ChatID,
					UserID:   c.userID,
					Username: c.username,
				})
			}

		case EventMessageRead:
			if clientMsg.Payload.MessageID == "" || clientMsg.Payload.ChatID == "" {
				log.Printf("Invalid read receipt payload from user_id=%s", c.userID)
				continue
			}
			c.hub.HandleReadReceipt(c, clientMsg.Payload.ChatID, clientMsg.Payload.MessageID)
		}
	}
}

func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
