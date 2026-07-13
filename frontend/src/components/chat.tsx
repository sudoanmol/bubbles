import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { UserAvatar } from '@/components/user-avatar'
import { useImageUpload } from '@/hooks/use-image-upload'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { formatRetryAfter } from '@/lib/utils'
import { getChatByIdFn, sendMessageFn } from '@/server/chat'
import type { Message } from '@/types/chat'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import EmojiPicker from 'emoji-picker-react'
import { ArrowLeftIcon, CornerUpLeftIcon, ImagePlusIcon, SmilePlusIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useDocumentTitle } from 'usehooks-ts'
import { Messages } from './messages'

type ChatProps = {
  chatId: string
}

export function Chat({ chatId }: ChatProps) {
  const navigate = useNavigate()
  const { user } = useRouteContext({ from: '__root__' })
  const [message, setMessage] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const focusMessageInput = useCallback(() => {
    requestAnimationFrame(() => {
      messageInputRef.current?.focus()
    })
  }, [])
  const clearReplySelection = useCallback(() => {
    setReplyTo(null)
    focusMessageInput()
  }, [focusMessageInput])

  const getChatByIdQuery = useServerFn(getChatByIdFn)
  const sendMessageQuery = useServerFn(sendMessageFn)
  const { selectedImages, setSelectedImages, handleFileChange, removeImage, clearImages, uploadImages, isUploading } =
    useImageUpload()
  const { typingUsers, handleTyping, stopTyping } = useTypingIndicator(chatId, user?.id || '')

  const {
    data: chat,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['chat', chatId],
    queryFn: async () => {
      const result = await getChatByIdQuery({ data: chatId })
      if ('error' in result && !result.success) {
        throw new Error(result.error)
      }
      return result.data
    },
  })

  useEffect(() => {
    if (isError) {
      toast.error(error instanceof Error ? error.message : 'Failed to load chat')
      navigate({ to: '/chats' })
    }
  }, [isError, error, navigate])

  useEffect(() => {
    setReplyTo(null)
  }, [chatId])

  const getOtherParticipant = () => {
    if (!chat || !user) return null
    return chat.members.find((member) => member.id !== user.id)
  }

  const otherParticipant = getOtherParticipant()
  const displayName = chat?.is_group ? chat.name || 'Group Chat' : otherParticipant?.username || 'Unknown'

  useDocumentTitle(chat ? `${displayName} - Bubbles` : 'Bubbles')

  const { mutateAsync: sendMessage, isPending: isSending } = useMutation({
    mutationFn: sendMessageQuery,
    onSuccess: (data) => {
      if (data.success) {
        setMessage('')
        clearImages()
      } else {
        const errorMessage = data.retry_after
          ? `${data.error} Try again in ${formatRetryAfter(data.retry_after)}.`
          : data.error || 'Failed to send message'
        toast.error(errorMessage)
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to send message')
    },
    onSettled: () => {
      focusMessageInput()
    },
  })

  const handleReplySelect = (message: Message) => {
    setReplyTo(message)
    setEmojiOpen(false)
    focusMessageInput()
  }

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()

    if (message.trim() === '' && selectedImages.length === 0) return
    if (!chat) return
    stopTyping()

    const messageContent = message.trim()
    const imagesToSend = [...selectedImages]
    const replyTarget = replyTo

    setMessage('')
    clearImages()
    if (replyTarget) {
      clearReplySelection()
    } else {
      focusMessageInput()
    }

    let imageUrls: string[] = []

    if (imagesToSend.length > 0) {
      const files = imagesToSend.map((img) => img.file)
      const uploadPromise = uploadImages(files)

      try {
        toast.promise(uploadPromise, {
          loading: 'Uploading images...',
          success: 'Images uploaded successfully',
          error: 'Failed to upload images',
        })

        imageUrls = await uploadPromise
      } catch (error) {
        setMessage(messageContent)
        const restoredImages = imagesToSend.map((img) => ({
          file: img.file,
          previewUrl: URL.createObjectURL(img.file),
        }))
        setSelectedImages(restoredImages)
        if (replyTarget) {
          setReplyTo(replyTarget)
        }
        focusMessageInput()
        return
      }
    }

    if (messageContent || imageUrls.length > 0) {
      await sendMessage({
        data: {
          chat_id: chatId,
          content: messageContent,
          images: imageUrls.length > 0 ? imageUrls : undefined,
          reply_to_message_id: replyTarget?.id,
        },
      })
    }
  }

  if (isLoading || !chat || !user) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading chat...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-neutral-300 bg-background/80 px-4 dark:border-zinc-800">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="lg:hidden"
            onClick={() => navigate({ to: '/chats' })}
            aria-label="Back to chats"
          >
            <ArrowLeftIcon className="size-5" />
          </Button>
          <div className="flex items-center gap-2">
            <UserAvatar
              className="size-9"
              username={displayName}
              image={chat?.is_group ? undefined : otherParticipant?.profile_image_url}
            />
            <div className="font-medium">{displayName}</div>
          </div>
        </div>

        <Messages
          chatId={chatId}
          isGroupChat={chat.is_group}
          currentUserId={user.id}
          members={chat.members}
          typingUsers={typingUsers}
          onReplySelect={handleReplySelect}
        />

        <form onSubmit={handleSendMessage} className="flex flex-col gap-2 px-3 py-2">
          {replyTo && (
            <div className="flex items-start gap-3 rounded-lg bg-muted/70 px-3 py-2 text-sm">
              <CornerUpLeftIcon className="mt-1 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    {replyTo.sender_id === user.id ? 'You' : replyTo.sender_username}
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={clearReplySelection}
                    aria-label="Cancel reply"
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {replyTo.is_deleted
                    ? 'This message was deleted'
                    : replyTo.content?.trim() ||
                      (replyTo.images.length > 0
                        ? `${replyTo.images.length} photo${replyTo.images.length > 1 ? 's' : ''}`
                        : 'No content')}
                </p>
                {!replyTo.is_deleted && replyTo.images.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    {replyTo.images.slice(0, 2).map((imageUrl, idx) => (
                      <img
                        key={imageUrl}
                        src={imageUrl}
                        alt={`Reply attachment ${idx + 1}`}
                        className="h-12 w-12 rounded-md object-cover"
                      />
                    ))}
                    {replyTo.images.length > 2 && (
                      <span className="flex items-center text-xs font-medium text-muted-foreground">
                        +{replyTo.images.length - 2} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {selectedImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {selectedImages.map((image, index) => (
                <div
                  key={index}
                  className="relative h-20 w-20 overflow-hidden rounded-lg border border-neutral-300 bg-muted dark:border-zinc-700"
                >
                  <img
                    src={image.previewUrl}
                    alt={`Selected image ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="destructive"
                    className="absolute right-1 top-1 h-5 w-5 rounded-full shadow-md"
                    onClick={() => removeImage(index)}
                    disabled={isSending || isUploading}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="relative flex-1">
            <Textarea
              autoFocus
              ref={messageInputRef}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value)
                handleTyping()
              }}
              rows={1}
              placeholder={isUploading ? 'Uploading images...' : 'Type a message...'}
              className="max-h-40 min-h-10 w-full resize-none bg-background pl-4 pr-24 focus-visible:ring-0 dark:bg-input/30 wrap-break-word text-sm!"
              disabled={isSending || isUploading}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <input
              type="file"
              className="hidden"
              ref={imageInputRef}
              onChange={handleFileChange}
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              multiple
              disabled={isSending || isUploading}
            />
            <div className="absolute inset-y-0 right-2 flex items-center gap-1">
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Open emoji picker"
                    disabled={isSending || isUploading}
                  >
                    <SmilePlusIcon className="size-5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-fit overflow-hidden p-0">
                  <EmojiPicker
                    lazyLoadEmojis
                    width={320}
                    onEmojiClick={(emoji) => {
                      setMessage((prev) => prev + emoji.emoji)
                      messageInputRef.current?.focus()
                      setEmojiOpen(false)
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Select image"
                onClick={() => imageInputRef.current?.click()}
                disabled={selectedImages.length >= 5 || isSending || isUploading}
              >
                <ImagePlusIcon className="size-5" />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
