package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

	"github.com/anmol7470/bubbles/backend/database"
	"github.com/anmol7470/bubbles/backend/middleware"
	"github.com/anmol7470/bubbles/backend/routes"
	"github.com/anmol7470/bubbles/backend/utils"
	ws "github.com/anmol7470/bubbles/backend/websocket"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("Warning: .env file not found, using environment variables")
	}

	// Initialize security logger
	utils.InitLogger()

	// Initialize database connection
	dbService, err := database.NewService()
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer dbService.Close()

	router := gin.Default()

	frontendURL := os.Getenv("FRONTEND_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:3000"
	}

	router.Use(cors.New(cors.Config{
		AllowOrigins:     []string{frontendURL},
		AllowMethods:     []string{"GET", "POST", "PUT", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "Accept", "X-Requested-With"},
		ExposeHeaders:    []string{"Content-Length", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	// Initialize rate limiter
	rateLimiter, err := middleware.NewRateLimiter()
	if err != nil {
		log.Printf("Warning: Failed to initialize rate limiter: %v", err)
		log.Println("Continuing without rate limiting...")
	}

	// Initialize WebSocket hub
	hub := ws.NewHub(dbService)

	// Initialize upload handler
	uploadHandler, err := routes.NewUploadHandler()
	if err != nil {
		log.Printf("Warning: Failed to initialize upload handler: %v", err)
	}

	// Initialize auth handler
	authHandler := routes.NewAuthHandler(dbService)

	// Auth routes (with rate limiting to prevent brute force)
	auth := router.Group("/auth")
	{
		if rateLimiter != nil {
			auth.POST("/signup", rateLimiter.AuthLimit(), authHandler.SignUp)
			auth.POST("/signin", rateLimiter.AuthLimit(), authHandler.SignIn)
		} else {
			auth.POST("/signup", authHandler.SignUp)
			auth.POST("/signin", authHandler.SignIn)
		}
		auth.GET("/verify", middleware.AuthMiddleware(), authHandler.Verify)
	}

	// Initialize chat handler
	chatHandler := routes.NewChatHandler(dbService, hub)
	chatActionsHandler := routes.NewChatActionsHandler(dbService, uploadHandler, hub)

	// Chat routes (with authentication)
	chat := router.Group("/chat")
	chat.Use(middleware.AuthMiddleware())
	{
		if rateLimiter != nil {
			chat.POST("/search-users", rateLimiter.SearchLimit(), chatHandler.SearchUsers)
		} else {
			chat.POST("/search-users", chatHandler.SearchUsers)
		}
		chat.POST("/create", chatHandler.CreateChat)
		chat.GET("/all", chatHandler.GetUserChats)
		chat.GET("/:id", chatHandler.GetChatById)

		chatActions := chat.Group("/:id")
		{
			chatActions.POST("/clear", chatActionsHandler.ClearChat)
			chatActions.POST("/delete", chatActionsHandler.DeleteChat)
			chatActions.POST("/leave", chatActionsHandler.LeaveChat)
			chatActions.POST("/rename", chatActionsHandler.RenameChat)
			chatActions.POST("/members/add", chatActionsHandler.AddChatMember)
			chatActions.POST("/members/remove", chatActionsHandler.RemoveChatMember)
			chatActions.POST("/change-admin", chatActionsHandler.ChangeChatAdmin)
		}
	}

	// Initialize message handler
	messageHandler := routes.NewMessageHandler(dbService, hub, uploadHandler)

	// Message routes (with authentication and rate limiting)
	messages := router.Group("/messages")
	messages.Use(middleware.AuthMiddleware())
	{
		if rateLimiter != nil {
			messages.POST("/send", rateLimiter.MessageLimit(), messageHandler.SendMessage)
		} else {
			messages.POST("/send", messageHandler.SendMessage)
		}
		messages.POST("/get", messageHandler.GetChatMessages)
		messages.POST("/edit", messageHandler.EditMessage)
		messages.POST("/delete", messageHandler.DeleteMessage)
	}

	// Upload routes (with authentication)
	if uploadHandler != nil {
		upload := router.Group("/upload")
		upload.Use(middleware.AuthMiddleware())
		{
			if rateLimiter != nil {
				upload.POST("/image", rateLimiter.UploadLimit(), uploadHandler.UploadImage)
			} else {
				upload.POST("/image", uploadHandler.UploadImage)
			}
		}
	}

	// User routes (with authentication)
	userHandler := routes.NewUserHandler(dbService)
	user := router.Group("/user")
	user.Use(middleware.AuthMiddleware())
	{
		user.PUT("/profile", userHandler.UpdateProfile)
	}

	// WebSocket endpoint (with authentication)
	router.GET("/ws", routes.HandleWebSocket(hub))

	// Health check with database connectivity verification
	router.GET("/health", func(c *gin.Context) {
		// Check database connection with timeout
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()

		if err := dbService.DB.PingContext(ctx); err != nil {
			log.Printf("Health check failed: %v", err)
			c.JSON(503, gin.H{
				"status":   "unhealthy",
				"database": "disconnected",
			})
			return
		}

		c.JSON(200, gin.H{
			"status":   "ok",
			"database": "connected",
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	// Create HTTP server
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: router,
	}

	// Start server in a goroutine
	go func() {
		log.Printf("Server starting on port %s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	// Give outstanding requests 10 seconds to complete
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	}

	// srv.Shutdown does not touch hijacked connections; close WebSocket
	// clients explicitly so they get a close frame.
	hub.Shutdown()

	log.Println("Server exited gracefully")
}
