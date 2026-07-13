package routes

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/anmol7470/bubbles/backend/database"
	"github.com/anmol7470/bubbles/backend/models"
	"github.com/anmol7470/bubbles/backend/utils"
	ws "github.com/anmol7470/bubbles/backend/websocket"
)

type ChatActionsHandler struct {
	dbService     *database.Service
	uploadHandler *UploadHandler
	hub           *ws.Hub
}

func NewChatActionsHandler(dbService *database.Service, uploadHandler *UploadHandler, hub *ws.Hub) *ChatActionsHandler {
	return &ChatActionsHandler{
		dbService:     dbService,
		uploadHandler: uploadHandler,
		hub:           hub,
	}
}

func (h *ChatActionsHandler) ClearChat(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	_, err := h.dbService.Queries.GetChatMember(c.Request.Context(), database.GetChatMemberParams{
		ChatID: chatID,
		UserID: userID,
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusForbidden, models.ErrorResponse{
				Error: "You are not a member of this chat",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify chat membership",
		})
		return
	}

	if err := h.dbService.Queries.UpdateChatMemberClearedAt(c.Request.Context(), database.UpdateChatMemberClearedAtParams{
		ChatID: chatID,
		UserID: userID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to clear chat",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) DeleteChat(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		_, err := h.dbService.Queries.GetChatMember(c.Request.Context(), database.GetChatMemberParams{
			ChatID: chatID,
			UserID: userID,
		})
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusForbidden, models.ErrorResponse{
					Error: "You are not a member of this chat",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to verify membership",
			})
			return
		}

		if err := h.dbService.Queries.UpdateChatMemberDeletedAt(c.Request.Context(), database.UpdateChatMemberDeletedAtParams{
			ChatID: chatID,
			UserID: userID,
		}); err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to delete chat",
			})
			return
		}

		stats, err := h.dbService.Queries.GetChatDeletionStats(c.Request.Context(), chatID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{
				Error: "Failed to verify chat deletion status",
			})
			return
		}

		fullyDeleted := stats.MemberCount == stats.DeletedCount
		if fullyDeleted {
			if err := h.deleteChatWithAssets(c.Request.Context(), chatID); err != nil {
				c.JSON(http.StatusInternalServerError, models.ErrorResponse{
					Error: "Failed to delete chat",
				})
				return
			}
			h.hub.EvictAllFromChat(chatID.String())
		}

		c.JSON(http.StatusOK, gin.H{
			"success":       true,
			"fully_deleted": fullyDeleted,
		})
		return
	}

	if chat.CreatedBy != userID {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "Only the chat creator can delete this group",
		})
		return
	}

	if err := h.deleteChatWithAssets(c.Request.Context(), chatID); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to delete chat",
		})
		return
	}
	h.hub.EvictAllFromChat(chatID.String())

	c.JSON(http.StatusOK, gin.H{
		"success":       true,
		"fully_deleted": true,
	})
}

func (h *ChatActionsHandler) LeaveChat(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot leave a direct message chat",
		})
		return
	}

	if chat.CreatedBy == userID {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Transfer admin rights before leaving the group",
		})
		return
	}

	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: userID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify membership",
		})
		return
	}

	if !isMember {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "You are not a member of this chat",
		})
		return
	}

	if err := h.dbService.Queries.RemoveChatMember(c.Request.Context(), database.RemoveChatMemberParams{
		ChatID: chatID,
		UserID: userID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to leave chat",
		})
		return
	}

	h.hub.EvictUserFromChat(userID.String(), chatID.String())

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) RenameChat(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	var req models.RenameChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	name := strings.TrimSpace(req.Name)
	if len(name) < 3 || len(name) > 20 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Group name must be between 3 and 20 characters",
		})
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot rename direct message chats",
		})
		return
	}

	if chat.CreatedBy != userID {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "Only the chat creator can rename this group",
		})
		return
	}

	if err := h.dbService.Queries.UpdateChatName(c.Request.Context(), database.UpdateChatNameParams{
		ID:   chatID,
		Name: sql.NullString{String: name, Valid: true},
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to rename chat",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) AddChatMember(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	var req models.ModifyChatMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid user ID",
		})
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot add members to a direct message chat",
		})
		return
	}

	if chat.CreatedBy != userID {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "Only the chat creator can add members",
		})
		return
	}

	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: targetID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify user membership",
		})
		return
	}

	if isMember {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "User is already a member of this chat",
		})
		return
	}

	if _, err := h.dbService.Queries.GetUserByID(c.Request.Context(), targetID); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "User not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load user",
		})
		return
	}

	if err := h.dbService.Queries.AddChatMember(c.Request.Context(), database.AddChatMemberParams{
		ChatID: chatID,
		UserID: targetID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to add member",
		})
		return
	}

	h.hub.NotifyChatCreated(chatID.String(), []uuid.UUID{targetID})

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) RemoveChatMember(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	var req models.ModifyChatMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid user ID",
		})
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot remove members from a direct message chat",
		})
		return
	}

	if chat.CreatedBy != userID {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "Only the chat creator can remove members",
		})
		return
	}

	if targetID == chat.CreatedBy {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Cannot remove the chat creator",
		})
		return
	}

	if targetID == userID {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Use leave chat to remove yourself",
		})
		return
	}

	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: targetID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify user membership",
		})
		return
	}

	if !isMember {
		c.JSON(http.StatusNotFound, models.ErrorResponse{
			Error: "User is not part of this chat",
		})
		return
	}

	if err := h.dbService.Queries.RemoveChatMember(c.Request.Context(), database.RemoveChatMemberParams{
		ChatID: chatID,
		UserID: targetID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to remove member",
		})
		return
	}

	h.hub.EvictUserFromChat(targetID.String(), chatID.String())

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) ChangeChatAdmin(c *gin.Context) {
	userID, ok := utils.GetUserIDFromContext(c)
	if !ok {
		return
	}

	chatID, ok := utils.ParseChatIDParam(c)
	if !ok {
		return
	}

	var req models.ChangeChatAdminRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: err.Error(),
		})
		return
	}

	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid user ID",
		})
		return
	}

	chat, err := h.dbService.Queries.GetChatMetadata(c.Request.Context(), chatID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, models.ErrorResponse{
				Error: "Chat not found",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to load chat",
		})
		return
	}

	if !chat.IsGroup {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Direct message chats do not support admins",
		})
		return
	}

	if chat.CreatedBy != userID {
		c.JSON(http.StatusForbidden, models.ErrorResponse{
			Error: "Only the chat creator can change admins",
		})
		return
	}

	if targetID == chat.CreatedBy {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "User is already the admin",
		})
		return
	}

	isMember, err := h.dbService.Queries.IsChatMember(c.Request.Context(), database.IsChatMemberParams{
		ChatID: chatID,
		UserID: targetID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to verify user membership",
		})
		return
	}

	if !isMember {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Selected user must be a member of this chat",
		})
		return
	}

	if err := h.dbService.Queries.UpdateChatCreator(c.Request.Context(), database.UpdateChatCreatorParams{
		ID:        chatID,
		CreatedBy: targetID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to change admin",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

func (h *ChatActionsHandler) deleteChatWithAssets(ctx context.Context, chatID uuid.UUID) error {
	imageURLs, err := h.dbService.Queries.GetChatImageUrls(ctx, chatID)
	if err != nil {
		return err
	}

	if err := h.dbService.Queries.DeleteChat(ctx, chatID); err != nil {
		return err
	}

	// Storage cleanup is best-effort: the chat is already gone from the DB,
	// so an orphaned object is preferable to failing the request.
	if h.uploadHandler != nil {
		for _, imageURL := range imageURLs {
			if err := h.uploadHandler.DeleteImage(imageURL); err != nil {
				log.Printf("Failed to delete image from storage: url=%s, err=%v", imageURL, err)
			}
		}
	}

	return nil
}
