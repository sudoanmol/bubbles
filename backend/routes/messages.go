package routes

import (
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/anmol7470/bubbles/backend/constants"
	"github.com/anmol7470/bubbles/backend/database"
	"github.com/anmol7470/bubbles/backend/models"
	ws "github.com/anmol7470/bubbles/backend/websocket"
)

type MessageHandler struct {
	dbService     *database.Service
	hub           *ws.Hub
	uploadHandler *UploadHandler
}

func NewMessageHandler(dbService *database.Service, hub *ws.Hub, uploadHandler *UploadHandler) *MessageHandler {
	return &MessageHandler{
		dbService:     dbService,
		hub:           hub,
		uploadHandler: uploadHandler,
	}
}

// deleteImagesFromStorage is best-effort cleanup after the DB rows are gone:
// an orphaned object is preferable to broken image URLs or a failed request.
func (h *MessageHandler) deleteImagesFromStorage(urls []string) {
	if h.uploadHandler == nil {
		return
	}
	for _, url := range urls {
		if err := h.uploadHandler.DeleteImage(url); err != nil {
			log.Printf("Failed to delete image from storage: url=%s, err=%v", url, err)
		}
	}
}

func (h *MessageHandler) GetChatMessages(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	var req models.GetChatMessagesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	chatID, err := uuid.Parse(req.ChatID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid chat ID",
		})
		return
	}

	// Verify user is member of chat
	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: userID.(uuid.UUID),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify chat membership",
		})
		return
	}

	if !isMember {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "You are not a member of this chat",
		})
		return
	}

	// Set default limit
	limit := req.Limit
	if limit <= 0 {
		limit = constants.DefaultMessagesPerPage
	} else if limit > constants.MaxMessagesPerPage {
		limit = constants.MaxMessagesPerPage
	}

	// Get messages with cursor-based pagination
	var cursorTime sql.NullTime
	var cursorID uuid.NullUUID

	if req.Cursor != nil {
		cursorTime = sql.NullTime{Time: req.Cursor.SentAt, Valid: true}
		cursorID = uuid.NullUUID{UUID: req.Cursor.ID, Valid: true}
	}

	messagesData, err := h.dbService.Queries.GetMessagesByChatPaginated(c.Request.Context(), database.GetMessagesByChatPaginatedParams{
		UserID:     userID.(uuid.UUID),
		ChatID:     chatID,
		CursorTime: cursorTime,
		CursorID:   cursorID,
		PageLimit:  int32(limit + 1), // Fetch one extra to check if there are more
	})

	if err != nil && err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get messages",
		})
		return
	}

	// Check if there are more messages
	hasMore := len(messagesData) > limit
	filteredMessages := messagesData
	if hasMore {
		filteredMessages = messagesData[:limit]
	}

	// Collect message IDs (including replied-to messages) for image lookup
	imageIDSet := make(map[uuid.UUID]struct{})
	for _, msg := range filteredMessages {
		imageIDSet[msg.ID] = struct{}{}
		if msg.ReplyToMessageID.Valid {
			imageIDSet[msg.ReplyToMessageID.UUID] = struct{}{}
		}
	}

	messageIDs := make([]uuid.UUID, 0, len(imageIDSet))
	for id := range imageIDSet {
		messageIDs = append(messageIDs, id)
	}

	// Get images for messages
	var imagesData []database.Image
	if len(messageIDs) > 0 {
		imagesData, err = h.dbService.Queries.GetMessageImages(c.Request.Context(), messageIDs)
		if err != nil && err != sql.ErrNoRows {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to get message images",
			})
			return
		}
	}

	// Group images by message ID
	imagesByMessage := make(map[uuid.UUID][]string)
	for _, img := range imagesData {
		imagesByMessage[img.MessageID] = append(imagesByMessage[img.MessageID], img.Url)
	}

	// Build messages response
	messages := make([]models.Message, len(filteredMessages))
	for i, msg := range filteredMessages {
		var content *string
		if msg.Content.Valid {
			content = &msg.Content.String
		}

		images := imagesByMessage[msg.ID]
		if images == nil {
			images = []string{}
		}

		var senderProfileImageUrl *string
		if msg.SenderProfileImageUrl.Valid {
			senderProfileImageUrl = &msg.SenderProfileImageUrl.String
		}

		var replyTo *models.ReplyToMessage
		if msg.ReplyToMessageID.Valid && msg.ReplySenderID.Valid {
			replyImages := imagesByMessage[msg.ReplyToMessageID.UUID]
			if replyImages == nil {
				replyImages = []string{}
			}

			var replyContent *string
			if msg.ReplyContent.Valid && !(msg.ReplyIsDeleted.Valid && msg.ReplyIsDeleted.Bool) {
				replyContent = &msg.ReplyContent.String
			}

			replyUsername := "Unknown"
			if msg.ReplySenderUsername.Valid {
				replyUsername = msg.ReplySenderUsername.String
			}

			var replySenderProfileImageUrl *string
			if msg.ReplySenderProfileImageUrl.Valid {
				replySenderProfileImageUrl = &msg.ReplySenderProfileImageUrl.String
			}

			replyTo = &models.ReplyToMessage{
				ID:                    msg.ReplyToMessageID.UUID,
				SenderID:              msg.ReplySenderID.UUID,
				SenderUsername:        replyUsername,
				SenderProfileImageUrl: replySenderProfileImageUrl,
				Content:               replyContent,
				Images:                replyImages,
				IsDeleted:             msg.ReplyIsDeleted.Valid && msg.ReplyIsDeleted.Bool,
			}
		}

		messages[i] = models.Message{
			ID:                    msg.ID,
			Content:               content,
			SenderID:              msg.SenderID,
			SenderUsername:        msg.SenderUsername,
			SenderProfileImageUrl: senderProfileImageUrl,
			IsDeleted:             msg.IsDeleted,
			IsEdited:              msg.IsEdited,
			Images:                images,
			CreatedAt:             msg.CreatedAt,
			ReplyTo:               replyTo,
		}
	}

	// Fetch read receipts for the chat
	readReceiptsData, err := h.dbService.Queries.GetChatReadReceipts(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get read receipts",
		})
		return
	}

	readReceipts := make([]models.ChatReadReceipt, len(readReceiptsData))
	for i, receipt := range readReceiptsData {
		readReceipts[i] = models.ChatReadReceipt{
			UserID:            receipt.UserID,
			LastReadMessageID: receipt.LastReadMessageID,
			LastReadAt:        receipt.LastReadAt,
		}
	}

	// Build response
	response := models.GetChatMessagesResponse{
		Items:        messages,
		ReadReceipts: readReceipts,
	}

	if hasMore && len(messages) > 0 {
		lastMsg := messages[len(messages)-1]
		response.NextCursor = &struct {
			SentAt time.Time `json:"sent_at"`
			ID     uuid.UUID `json:"id"`
		}{
			SentAt: lastMsg.CreatedAt,
			ID:     lastMsg.ID,
		}
	}

	c.JSON(http.StatusOK, response)
}

func (h *MessageHandler) SendMessage(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	var req models.SendMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	// Validate input
	req.Content = strings.TrimSpace(req.Content)

	if len(req.Content) > constants.MaxMessageLength {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Message content exceeds maximum length of 5000 characters",
		})
		return
	}

	if len(req.Images) > constants.MaxImagesPerMessage {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Maximum 5 images allowed per message",
		})
		return
	}

	chatID, err := uuid.Parse(req.ChatID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid chat ID",
		})
		return
	}

	// Verify user is member of chat
	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: userID.(uuid.UUID),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify chat membership",
		})
		return
	}

	if !isMember {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "You are not a member of this chat",
		})
		return
	}

	// Validate that message has content or images
	if req.Content == "" && len(req.Images) == 0 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Message must have content or images",
		})
		return
	}

	// Validate reply target if provided
	var replyTo uuid.NullUUID
	var replyPayload *ws.ReplyMessage
	if req.ReplyToMessageID != nil {
		replyIDStr := strings.TrimSpace(*req.ReplyToMessageID)
		if replyIDStr != "" {
			replyUUID, err := uuid.Parse(replyIDStr)
			if err != nil {
				c.JSON(http.StatusBadRequest, models.ErrorResponse{
					Error: "Invalid reply_to_message_id",
				})
				return
			}

			replyMessage, err := h.dbService.Queries.GetMessageById(c.Request.Context(), replyUUID)
			if err != nil {
				if err == sql.ErrNoRows {
					c.JSON(http.StatusNotFound, models.ErrorResponse{
						Error: "Replied message not found",
					})
					return
				}
				c.JSON(http.StatusInternalServerError, models.ErrorResponse{
					Error: "Failed to fetch replied message",
				})
				return
			}

			if replyMessage.ChatID != chatID {
				c.JSON(http.StatusBadRequest, models.ErrorResponse{
					Error: "Cannot reply to a message from another chat",
				})
				return
			}

			user, err := h.dbService.Queries.GetUserByID(c.Request.Context(), replyMessage.SenderID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, models.ErrorResponse{
					Error: "Failed to get replied message sender",
				})
				return
			}

			replyImageRows, err := h.dbService.Queries.GetMessageImages(c.Request.Context(), []uuid.UUID{replyUUID})
			if err != nil && err != sql.ErrNoRows {
				c.JSON(http.StatusInternalServerError, models.ErrorResponse{
					Error: "Failed to get replied message images",
				})
				return
			}

			replyImages := make([]string, 0, len(replyImageRows))
			for _, img := range replyImageRows {
				replyImages = append(replyImages, img.Url)
			}

			var replyContent *string
			if replyMessage.Content.Valid && !replyMessage.IsDeleted {
				replyContent = &replyMessage.Content.String
			}

			replyTo = uuid.NullUUID{UUID: replyUUID, Valid: true}
			replyPayload = &ws.ReplyMessage{
				ID:             replyUUID.String(),
				SenderID:       replyMessage.SenderID.String(),
				SenderUsername: user.Username,
				Content:        replyContent,
				Images:         replyImages,
				IsDeleted:      replyMessage.IsDeleted,
			}
		}
	}

	// Use transaction to ensure message creation and image addition are atomic
	tx, err := h.dbService.DB.BeginTx(c.Request.Context(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to begin transaction",
		})
		return
	}
	defer tx.Rollback()

	qtx := h.dbService.Queries.WithTx(tx)

	// Create message
	var content sql.NullString
	if req.Content != "" {
		content = sql.NullString{String: req.Content, Valid: true}
	}

	message, err := qtx.CreateMessage(c.Request.Context(), database.CreateMessageParams{
		ChatID:           chatID,
		SenderID:         userID.(uuid.UUID),
		Content:          content,
		ReplyToMessageID: replyTo,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to create message",
		})
		return
	}

	// Add images if any
	for _, imageUrl := range req.Images {
		err := qtx.AddMessageImage(c.Request.Context(), database.AddMessageImageParams{
			MessageID: message.ID,
			Url:       imageUrl,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to add message image",
			})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to commit transaction",
		})
		return
	}

	// Use the DB username rather than the token claim, which can be stale
	// for up to the token lifetime after a rename.
	senderUsername := ""
	if sender, err := h.dbService.Queries.GetUserByID(c.Request.Context(), userID.(uuid.UUID)); err == nil {
		senderUsername = sender.Username
	} else if username, ok := c.Get("username"); ok {
		senderUsername, _ = username.(string)
	}

	// Prepare content for broadcast
	var broadcastContent *string
	if content.Valid {
		broadcastContent = &content.String
	}

	// Broadcast message to WebSocket clients
	h.hub.BroadcastToChat(chatID.String(), ws.WSMessage{
		Type: ws.EventMessageSent,
		Payload: ws.MessageSentPayload{
			ID:             message.ID.String(),
			ChatID:         chatID.String(),
			SenderID:       userID.(uuid.UUID).String(),
			SenderUsername: senderUsername,
			Content:        broadcastContent,
			Images:         req.Images,
			IsDeleted:      false,
			IsEdited:       false,
			CreatedAt:      message.CreatedAt,
			ReplyTo:        replyPayload,
		},
	})

	c.JSON(http.StatusOK, gin.H{
		"message_id": message.ID,
	})
}

func (h *MessageHandler) EditMessage(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	var req models.EditMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	messageID, err := uuid.Parse(req.MessageID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid message ID",
		})
		return
	}

	req.Content = strings.TrimSpace(req.Content)

	if len(req.Content) > constants.MaxMessageLength {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Message content exceeds maximum length of 5000 characters",
		})
		return
	}

	message, err := h.dbService.Queries.GetMessageById(c.Request.Context(), messageID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Message not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get message",
		})
		return
	}

	if message.SenderID != userID.(uuid.UUID) {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "You can only edit your own messages",
		})
		return
	}

	if message.IsDeleted {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot edit a deleted message",
		})
		return
	}

	if time.Since(message.CreatedAt) > 15*time.Minute {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Messages can only be edited within 15 minutes of sending",
		})
		return
	}

	currentImages, err := h.dbService.Queries.GetMessageImages(c.Request.Context(), []uuid.UUID{messageID})
	if err != nil && err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get message images",
		})
		return
	}

	removedSet := make(map[string]struct{}, len(req.RemovedImages))
	for _, url := range req.RemovedImages {
		removedSet[url] = struct{}{}
	}

	imageUrls := make([]string, 0, len(currentImages))
	for _, img := range currentImages {
		if _, removed := removedSet[img.Url]; !removed {
			imageUrls = append(imageUrls, img.Url)
		}
	}

	if req.Content == "" && len(imageUrls) == 0 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Message must have content or images",
		})
		return
	}

	tx, err := h.dbService.DB.BeginTx(c.Request.Context(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to begin transaction",
		})
		return
	}
	defer tx.Rollback()

	qtx := h.dbService.Queries.WithTx(tx)

	var content sql.NullString
	if req.Content != "" {
		content = sql.NullString{String: req.Content, Valid: true}
	}

	updatedAt, err := qtx.EditMessage(c.Request.Context(), database.EditMessageParams{
		ID:      messageID,
		Content: content,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to edit message",
		})
		return
	}

	if len(req.RemovedImages) > 0 {
		err = qtx.DeleteMessageImages(c.Request.Context(), database.DeleteMessageImagesParams{
			MessageID: messageID,
			Column2:   req.RemovedImages,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to delete images from database",
			})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to commit transaction",
		})
		return
	}

	h.deleteImagesFromStorage(req.RemovedImages)

	// Prepare content for broadcast
	var broadcastContent *string
	if content.Valid {
		broadcastContent = &content.String
	}

	// Broadcast edit to WebSocket clients
	h.hub.BroadcastToChat(message.ChatID.String(), ws.WSMessage{
		Type: ws.EventMessageEdited,
		Payload: ws.MessageEditedPayload{
			ID:        messageID.String(),
			ChatID:    message.ChatID.String(),
			Content:   broadcastContent,
			Images:    imageUrls,
			IsEdited:  true,
			UpdatedAt: updatedAt,
		},
	})

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *MessageHandler) DeleteMessage(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	var req models.DeleteMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	messageID, err := uuid.Parse(req.MessageID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid message ID",
		})
		return
	}

	message, err := h.dbService.Queries.GetMessageById(c.Request.Context(), messageID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Message not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get message",
		})
		return
	}

	if message.SenderID != userID.(uuid.UUID) {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "You can only delete your own messages",
		})
		return
	}

	images, err := h.dbService.Queries.GetMessageImages(c.Request.Context(), []uuid.UUID{messageID})
	if err != nil && err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get message images",
		})
		return
	}

	tx, err := h.dbService.DB.BeginTx(c.Request.Context(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to begin transaction",
		})
		return
	}
	defer tx.Rollback()

	qtx := h.dbService.Queries.WithTx(tx)

	err = qtx.DeleteMessage(c.Request.Context(), messageID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to delete message",
		})
		return
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to commit transaction",
		})
		return
	}

	// Broadcast delete to WebSocket clients
	h.hub.BroadcastToChat(message.ChatID.String(), ws.WSMessage{
		Type: ws.EventMessageDeleted,
		Payload: ws.MessageDeletedPayload{
			ID:        messageID.String(),
			ChatID:    message.ChatID.String(),
			IsDeleted: true,
		},
	})

	imageUrls := make([]string, 0, len(images))
	for _, image := range images {
		imageUrls = append(imageUrls, image.Url)
	}
	h.deleteImagesFromStorage(imageUrls)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}
