package routes

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/anmol7470/bubbles/backend/constants"
	"github.com/anmol7470/bubbles/backend/models"
)

type UploadHandler struct {
	s3Client   *s3.Client
	bucketName string
	publicURL  string
}

func NewUploadHandler() (*UploadHandler, error) {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKeyID := os.Getenv("R2_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("R2_SECRET_ACCESS_KEY")
	bucketName := os.Getenv("R2_BUCKET_NAME")
	publicURL := os.Getenv("R2_PUBLIC_URL")

	if accountID == "" || accessKeyID == "" || secretAccessKey == "" || bucketName == "" || publicURL == "" {
		return nil, fmt.Errorf("missing required R2 configuration")
	}

	// Construct the R2 endpoint
	r2Endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)

	// Create AWS config with custom credentials
	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			accessKeyID,
			secretAccessKey,
			"",
		)),
		config.WithRegion("auto"),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	// Create S3 client with R2 endpoint
	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(r2Endpoint)
	})

	return &UploadHandler{
		s3Client:   s3Client,
		bucketName: bucketName,
		publicURL:  publicURL,
	}, nil
}

var allowedImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/jpg":  true,
	"image/png":  true,
	"image/webp": true,
}

func (h *UploadHandler) UploadImage(c *gin.Context) {
	// Get user ID from context (set by auth middleware)
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{
			Error: "User ID not found in context",
		})
		return
	}

	// Parse multipart form with max size limit
	if err := c.Request.ParseMultipartForm(constants.MaxImageSize); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "File too large. Maximum size is 4MB",
		})
		return
	}

	// Get the file from the form
	file, header, err := c.Request.FormFile("image")
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "No image file provided",
		})
		return
	}
	defer file.Close()

	// Validate file size
	if header.Size > constants.MaxImageSize {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "File too large. Maximum size is 4MB",
		})
		return
	}

	// Detect content type
	buffer := make([]byte, 512)
	n, err := file.Read(buffer)
	if err != nil && err != io.EOF {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to read file",
		})
		return
	}
	contentType := http.DetectContentType(buffer[:n])

	// Validate content type
	if !allowedImageTypes[contentType] {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{
			Error: "Invalid file type. Only JPEG, PNG, and WebP images are allowed",
		})
		return
	}

	// Reset file pointer to beginning
	_, err = file.Seek(0, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to process file",
		})
		return
	}

	// Read entire file into memory
	fileBytes, err := io.ReadAll(file)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to read file",
		})
		return
	}

	// Generate unique filename
	ext := filepath.Ext(header.Filename)
	if ext == "" {
		// Determine extension from content type
		switch contentType {
		case "image/jpeg":
			ext = ".jpg"
		case "image/png":
			ext = ".png"
		case "image/webp":
			ext = ".webp"
		}
	}

	// Create a unique key with user ID and timestamp
	timestamp := time.Now().Unix()
	filename := fmt.Sprintf("%s/%d/%s%s", userID, timestamp, uuid.New().String(), ext)

	// Upload to R2
	_, err = h.s3Client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket:      aws.String(h.bucketName),
		Key:         aws.String(filename),
		Body:        bytes.NewReader(fileBytes),
		ContentType: aws.String(contentType),
	})

	if err != nil {
		log.Printf("Failed to upload image to storage: %v", err)
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{
			Error: "Failed to upload image",
		})
		return
	}

	// Construct public URL
	var imageURL = fmt.Sprintf("%s/%s", strings.TrimSuffix(h.publicURL, "/"), filename)

	c.JSON(http.StatusOK, gin.H{
		"url": imageURL,
	})
}

func (h *UploadHandler) DeleteImage(imageURL string) error {
	key := strings.TrimPrefix(imageURL, h.publicURL+"/")
	key = strings.TrimPrefix(key, h.publicURL)
	key = strings.TrimPrefix(key, "/")

	_, err := h.s3Client.DeleteObject(context.Background(), &s3.DeleteObjectInput{
		Bucket: aws.String(h.bucketName),
		Key:    aws.String(key),
	})

	return err
}
