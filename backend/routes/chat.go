package routes

import (
	"database/sql"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"github.com/anmol7470/bubbles/backend/constants"
	"github.com/anmol7470/bubbles/backend/database"
	"github.com/anmol7470/bubbles/backend/models"
	"github.com/anmol7470/bubbles/backend/utils"
	ws "github.com/anmol7470/bubbles/backend/websocket"
)

type ChatHandler struct {
	dbService *database.Service
	hub       *ws.Hub
}

func NewChatHandler(dbService *database.Service, hub *ws.Hub) *ChatHandler {
	return &ChatHandler{
		dbService: dbService,
		hub:       hub,
	}
}

func (h *ChatHandler) SearchUsers(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	var req models.SearchUsersRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	// Escape ILIKE special characters to prevent pattern injection
	escapedQuery := utils.EscapeLikePattern(req.Query)

	// Always exclude the requester server-side; a nil array would make
	// `id != ALL(NULL)` match nothing.
	excludedIds := append([]uuid.UUID{userID}, req.SelectedUserIds...)

	users, err := h.dbService.Queries.SearchUsers(c.Request.Context(), database.SearchUsersParams{
		Query:       sql.NullString{String: escapedQuery, Valid: true},
		ExcludedIds: excludedIds,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to search users",
		})
		return
	}

	result := make([]models.SearchUsersResponse, len(users))
	for i, user := range users {
		result[i] = models.SearchUsersResponse{
			ID:              user.ID,
			Username:        user.Username,
			ProfileImageURL: utils.NullableString(user.ProfileImageUrl),
		}
	}

	c.JSON(http.StatusOK, result)
}

func (h *ChatHandler) CreateChat(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	var req models.CreateChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	memberMap := make(map[uuid.UUID]struct{})
	for _, memberID := range req.MemberIds {
		memberMap[memberID] = struct{}{}
	}
	memberMap[userID] = struct{}{}

	memberIds := make([]uuid.UUID, 0, len(memberMap))
	for id := range memberMap {
		memberIds = append(memberIds, id)
	}

	if len(memberIds) < 2 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "At least two unique members are required",
		})
		return
	}

	if len(memberIds) > constants.MaxChatMembers {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "A chat can have at most 50 members",
		})
		return
	}

	// Sort member IDs for consistent chat lookup
	sort.Slice(memberIds, func(i, j int) bool {
		return memberIds[i].String() < memberIds[j].String()
	})

	isGroup := len(memberIds) > 2

	var chatID uuid.UUID
	var existing bool

	if !isGroup {
		existingChat, err := h.dbService.Queries.GetChatByMembers(c.Request.Context(), database.GetChatByMembersParams{
			MemberIds:   memberIds,
			MemberCount: int64(len(memberIds)),
		})

		if err == nil {
			chatID = existingChat.ID
			existing = true
		} else if err != sql.ErrNoRows {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to check existing chat",
			})
			return
		}
	}

	if !existing {
		// Use transaction to ensure chat creation and member addition are atomic
		tx, err := h.dbService.DB.BeginTx(c.Request.Context(), nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to begin transaction",
			})
			return
		}
		defer tx.Rollback()

		qtx := h.dbService.Queries.WithTx(tx)

		var chatName sql.NullString
		if trimmed := strings.TrimSpace(req.GroupName); trimmed != "" {
			chatName = sql.NullString{String: trimmed, Valid: true}
		}

		chat, err := qtx.CreateChat(c.Request.Context(), database.CreateChatParams{
			Name:      chatName,
			IsGroup:   isGroup,
			CreatedBy: userID,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to create chat",
			})
			return
		}

		chatID = chat.ID

		for _, memberID := range memberIds {
			err := qtx.AddChatMember(c.Request.Context(), database.AddChatMemberParams{
				ChatID: chatID,
				UserID: memberID,
			})

			if err != nil {
				// 23503 = foreign_key_violation: the member ID does not exist
				if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23503" {
					c.JSON(http.StatusBadRequest, models.ErrorResponse{
						Error: "One or more selected users do not exist",
					})
					return
				}
				c.JSON(http.StatusInternalServerError, models.ErrorResponse{
					Error: "Failed to add chat member",
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

		h.hub.NotifyChatCreated(chatID.String(), memberIds)
	}

	c.JSON(http.StatusOK, models.CreateChatResponse{
		ChatID:   chatID,
		Existing: existing,
	})
}

func (h *ChatHandler) GetUserChats(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	rows, err := h.dbService.Queries.GetChatsWithMembers(c.Request.Context(), userID.(uuid.UUID))
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get chats",
		})
		return
	}

	// Group rows by chat ID and collect message IDs
	chatsMap := make(map[uuid.UUID]*models.ChatInfo)
	var chatOrder []uuid.UUID
	var messageIDs []uuid.UUID
	messageIDSet := make(map[uuid.UUID]bool)

	for _, row := range rows {
		if _, exists := chatsMap[row.ChatID]; !exists {
			var name *string
			if row.ChatName.Valid {
				name = &row.ChatName.String
			}

			chatInfo := &models.ChatInfo{
				ID:          row.ChatID,
				Name:        name,
				IsGroup:     row.IsGroup,
				CreatorID:   row.CreatedBy,
				Members:     []models.ChatMember{},
				UnreadCount: int32(row.UnreadCount),
				CreatedAt:   row.ChatCreatedAt,
				UpdatedAt:   row.ChatUpdatedAt,
			}

			// Add last message if exists (check if ID is not zero UUID)
			if row.LastMessageID != uuid.Nil {
				var content *string
				if row.LastMessageContent.Valid {
					content = &row.LastMessageContent.String
				}

				var sender *models.MessageSender
				if row.LastMessageSenderID != uuid.Nil && row.LastMessageSenderUsername.Valid {
					sender = &models.MessageSender{
						ID:              row.LastMessageSenderID,
						Username:        row.LastMessageSenderUsername.String,
						ProfileImageURL: utils.NullableString(row.LastMessageSenderProfileImageUrl),
					}
				}

				chatInfo.LastMessage = &models.LastMessage{
					ID:        row.LastMessageID,
					Content:   content,
					Sender:    sender,
					IsDeleted: row.LastMessageIsDeleted,
					Images:    []string{},
					CreatedAt: row.LastMessageCreatedAt,
				}

				// Collect message ID for fetching images
				if !messageIDSet[row.LastMessageID] {
					messageIDs = append(messageIDs, row.LastMessageID)
					messageIDSet[row.LastMessageID] = true
				}
			}

			chatsMap[row.ChatID] = chatInfo
			chatOrder = append(chatOrder, row.ChatID)
		}

		chatsMap[row.ChatID].Members = append(chatsMap[row.ChatID].Members, models.ChatMember{
			ID:              row.MemberID,
			Username:        row.MemberUsername,
			ProfileImageURL: utils.NullableString(row.MemberProfileImageUrl),
		})
	}

	// Fetch images for all messages
	if len(messageIDs) > 0 {
		images, err := h.dbService.Queries.GetLastMessageImages(c.Request.Context(), messageIDs)
		if err == nil {
			// Group images by message ID
			imagesByMessage := make(map[uuid.UUID][]string)
			for _, img := range images {
				imagesByMessage[img.MessageID] = append(imagesByMessage[img.MessageID], img.Url)
			}

			// Assign images to last messages
			for _, chat := range chatsMap {
				if chat.LastMessage != nil {
					if imgs, ok := imagesByMessage[chat.LastMessage.ID]; ok {
						chat.LastMessage.Images = imgs
					}
				}
			}
		}
	}

	// Convert map to array preserving order
	result := make([]models.ChatInfo, 0, len(chatOrder))
	for _, chatID := range chatOrder {
		result = append(result, *chatsMap[chatID])
	}

	c.JSON(http.StatusOK, models.GetChatsResponse{
		Chats: result,
	})
}

func (h *ChatHandler) GetChatById(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	// Verify user is member of chat first (efficient EXISTS query)
	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: userID,
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

	// Get chat info with members
	chatMembers, err := h.dbService.Queries.GetChatByIdWithMembers(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to get chat",
		})
		return
	}

	if len(chatMembers) == 0 {
		c.JSON(http.StatusNotFound, models.ErrorResponse{
			Error: "Chat not found",
		})
		return
	}

	// Build members list
	membersMap := make(map[uuid.UUID]models.ChatMember)
	for _, member := range chatMembers {
		membersMap[member.MemberID] = models.ChatMember{
			ID:              member.MemberID,
			Username:        member.MemberUsername,
			ProfileImageURL: utils.NullableString(member.MemberProfileImageUrl),
		}
	}

	members := make([]models.ChatMember, 0, len(membersMap))
	for _, member := range membersMap {
		members = append(members, member)
	}

	// Build response
	var name *string
	if chatMembers[0].ChatName.Valid {
		name = &chatMembers[0].ChatName.String
	}

	response := models.GetChatByIdResponse{
		ID:        chatMembers[0].ChatID,
		Name:      name,
		IsGroup:   chatMembers[0].IsGroup,
		CreatorID: chatMembers[0].CreatedBy,
		Members:   members,
		CreatedAt: chatMembers[0].ChatCreatedAt,
		UpdatedAt: chatMembers[0].ChatUpdatedAt,
	}

	c.JSON(http.StatusOK, response)
}
