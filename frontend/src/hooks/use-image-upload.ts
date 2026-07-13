import { getAuthTokenFn } from '@/server/chat'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export type ImagePreview = {
  file: File
  previewUrl: string
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'webp'])

type UseImageUploadOptions = {
  maxImages?: number
  replaceExisting?: boolean
}

export function useImageUpload(options: UseImageUploadOptions = {}) {
  const [selectedImages, setSelectedImages] = useState<ImagePreview[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const getAuthToken = useServerFn(getAuthTokenFn)
  const { maxImages = 5, replaceExisting = false } = options

  // Cleanup Object URLs on component unmount to prevent memory leaks; the
  // ref avoids a stale closure over the initial (empty) selection.
  const selectedImagesRef = useRef<ImagePreview[]>(selectedImages)
  selectedImagesRef.current = selectedImages
  useEffect(() => {
    return () => {
      selectedImagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    }
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    const validFiles: File[] = []
    const errors: string[] = []

    Array.from(files).forEach((file) => {
      // Check if it's an image
      if (!file.type.startsWith('image/')) {
        errors.push(`${file.name} is not an image file`)
        return
      }

      const mimeType = file.type.toLowerCase()
      const extension = file.name.split('.').pop()?.toLowerCase()
      const isAllowedType = ALLOWED_IMAGE_TYPES.has(mimeType)
      const isAllowedExtension = extension ? ALLOWED_IMAGE_EXTENSIONS.has(extension) : false

      if (!isAllowedType && !isAllowedExtension) {
        errors.push(`${file.name} must be JPEG, JPG, PNG, or WebP`)
        return
      }

      // Check file size (4MB limit)
      if (file.size > MAX_IMAGE_SIZE) {
        errors.push(`${file.name} exceeds 4MB limit`)
        return
      }

      // Check for duplicates (by name and size)
      const isDuplicate = selectedImages.some((img) => img.file.name === file.name && img.file.size === file.size)

      if (isDuplicate) {
        errors.push(`${file.name} is already selected`)
        return
      }

      validFiles.push(file)
    })

    // Check max count
    const existingCount = replaceExisting ? 0 : selectedImages.length
    const availableSlots = Math.max(maxImages - existingCount, 0)

    if (validFiles.length > availableSlots) {
      const extraCount = validFiles.length - availableSlots
      errors.push(`Can only select ${availableSlots} more image${availableSlots === 1 ? '' : 's'}`)
      validFiles.splice(validFiles.length - extraCount, extraCount)
    }

    // Create preview URLs
    const newPreviews: ImagePreview[] = validFiles.slice(0, maxImages).map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }))

    setSelectedImages((prev) => {
      if (replaceExisting) {
        prev.forEach((img) => URL.revokeObjectURL(img.previewUrl))
        return newPreviews.slice(0, maxImages)
      }
      const combined = [...prev, ...newPreviews]
      return combined.slice(0, maxImages)
    })

    // Show errors if any
    if (errors.length > 0) {
      toast.error(errors.join('\n'))
    }

    e.target.value = ''
  }

  const removeImage = (index: number) => {
    setSelectedImages((prev) => {
      const newImages = [...prev]
      // Revoke the object URL to free memory
      URL.revokeObjectURL(newImages[index].previewUrl)
      newImages.splice(index, 1)
      return newImages
    })
  }

  const clearImages = () => {
    selectedImages.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    setSelectedImages([])
  }

  const uploadImages = async (files: File[]): Promise<string[]> => {
    setIsUploading(true)

    try {
      const errors: string[] = []

      // Get auth token
      const token = await getAuthToken()
      if (!token) {
        throw new Error('Authentication required')
      }

      // Upload all images concurrently
      const uploadPromises = files.map(async (file) => {
        try {
          const formData = new FormData()
          formData.append('image', file)

          const response = await fetch(`${BACKEND_URL}/upload/image`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: formData,
          })

          if (!response.ok) {
            const error = await response.json()
            const errorMsg = error.error || 'Failed to upload image'
            errors.push(`${file.name}: ${errorMsg}`)
            return null
          }

          const result: { url: string } = await response.json()
          return result.url
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Upload failed'
          errors.push(`${file.name}: ${errorMsg}`)
          return null
        }
      })

      const results = await Promise.all(uploadPromises)

      // Filter out null values (failed uploads)
      const successfulUrls = results.filter((url): url is string => url !== null)

      if (errors.length > 0) {
        throw new Error(errors.join('\n'))
      }

      return successfulUrls
    } finally {
      setIsUploading(false)
    }
  }

  return {
    selectedImages,
    setSelectedImages,
    handleFileChange,
    removeImage,
    clearImages,
    uploadImages,
    isUploading,
  }
}
