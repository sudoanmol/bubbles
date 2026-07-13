package middleware

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/ulule/limiter/v3"
	sredis "github.com/ulule/limiter/v3/drivers/store/redis"
)

type RateLimiter struct {
	authLimiter    *limiter.Limiter
	searchLimiter  *limiter.Limiter
	messageLimiter *limiter.Limiter
	uploadLimiter  *limiter.Limiter
}

func NewRateLimiter() (*RateLimiter, error) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379/0"
	}

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}

	client := redis.NewClient(opt)
	store, err := sredis.NewStoreWithOptions(client, limiter.StoreOptions{
		Prefix: "bubbles_limiter",
	})
	if err != nil {
		return nil, err
	}

	// Rate limits:
	// Auth: 5 requests per 10 minutes (prevent brute force)
	// Search: 30 requests per minute (prevent spam searches)
	// Messages: 60 requests per minute (allow normal chatting)
	// Upload: 20 requests per minute (prevent abuse of image uploads)

	authLimiter := limiter.New(store, limiter.Rate{
		Period: 10 * time.Minute,
		Limit:  5,
	})

	searchLimiter := limiter.New(store, limiter.Rate{
		Period: 1 * time.Minute,
		Limit:  30,
	})

	messageLimiter := limiter.New(store, limiter.Rate{
		Period: 1 * time.Minute,
		Limit:  60,
	})

	uploadLimiter := limiter.New(store, limiter.Rate{
		Period: 1 * time.Minute,
		Limit:  20,
	})

	return &RateLimiter{
		authLimiter:    authLimiter,
		searchLimiter:  searchLimiter,
		messageLimiter: messageLimiter,
		uploadLimiter:  uploadLimiter,
	}, nil
}

func (rl *RateLimiter) AuthLimit() gin.HandlerFunc {
	return rl.createIPBasedMiddleware(rl.authLimiter)
}

func (rl *RateLimiter) SearchLimit() gin.HandlerFunc {
	return rl.createUserBasedMiddleware(rl.searchLimiter)
}

func (rl *RateLimiter) MessageLimit() gin.HandlerFunc {
	return rl.createUserBasedMiddleware(rl.messageLimiter)
}

func (rl *RateLimiter) UploadLimit() gin.HandlerFunc {
	return rl.createUserBasedMiddleware(rl.uploadLimiter)
}

// IP-based rate limiting for unauthenticated endpoints (auth)
func (rl *RateLimiter) createIPBasedMiddleware(lmt *limiter.Limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.ClientIP()

		context, err := lmt.Get(c.Request.Context(), key)
		if err != nil {
			// Fail open, consistent with the user-based limiter and the
			// no-Redis-at-boot behavior: a rate limiter outage must not
			// become a login outage.
			log.Printf("Rate limiter error, allowing request: %v", err)
			c.Next()
			return
		}

		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", context.Limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", context.Remaining))
		c.Header("X-RateLimit-Reset", fmt.Sprintf("%d", context.Reset))

		if context.Reached {
			retryAfter := time.Until(time.Unix(context.Reset, 0))
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "Rate limit exceeded. Please try again later.",
				"retry_after": int(retryAfter.Seconds()),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

// User-based rate limiting for authenticated endpoints (search, messages)
func (rl *RateLimiter) createUserBasedMiddleware(lmt *limiter.Limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Get user ID from context (set by auth middleware)
		userID, exists := c.Get("user_id")
		if !exists {
			// Fallback to IP if user ID not found
			key := c.ClientIP()
			context, err := lmt.Get(c.Request.Context(), key)
			if err != nil {
				log.Printf("Rate limiter error: %v", err)
				c.Next()
				return
			}

			c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", context.Limit))
			c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", context.Remaining))
			c.Header("X-RateLimit-Reset", fmt.Sprintf("%d", context.Reset))

			if context.Reached {
				c.JSON(http.StatusTooManyRequests, gin.H{
					"error": "Rate limit exceeded. Please try again later.",
				})
				c.Abort()
				return
			}

			c.Next()
			return
		}

		// Use user ID as rate limit key
		key := fmt.Sprintf("user:%v", userID)

		context, err := lmt.Get(c.Request.Context(), key)
		if err != nil {
			log.Printf("Rate limiter error: %v", err)
			c.Next()
			return
		}

		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", context.Limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", context.Remaining))
		c.Header("X-RateLimit-Reset", fmt.Sprintf("%d", context.Reset))

		if context.Reached {
			retryAfter := time.Until(time.Unix(context.Reset, 0))
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "Rate limit exceeded. Please try again later.",
				"retry_after": int(retryAfter.Seconds()),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
