import { useWebSocket } from '@/contexts/websocket-context'
import { useChatWebSocket } from '@/hooks/use-chat-websocket'
import { useScroll } from '@/hooks/use-scroll'
import type { TypingUser } from '@/hooks/use-typing-indicator'
import { cn, formatDate } from '@/lib/utils'
import { getChatMessagesFn } from '@/server/chat'
import type { ChatInfo, ChatMember, ChatReadReceipt, Message } from '@/types/chat'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowDownIcon, Loader2Icon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { MessageContent } from './message-content'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { UserAvatar } from './user-avatar'

type MessagesProps = {
  chatId: string
  isGroupChat: boolean
  currentUserId: string
  members: ChatMember[]
  typingUsers: TypingUser[]
  onReplySelect: (message: Message) => void
}

type ReadReceiptState = 'read' | 'unread'

export function Messages({ chatId, isGroupChat, currentUserId, members, typingUsers, onReplySelect }: MessagesProps) {
  const getChatMessagesQuery = useServerFn(getChatMessagesFn)
  const observerTarget = useRef<HTMLDivElement>(null)
  const { send } = useWebSocket()
  const queryClient = useQueryClient()

  useChatWebSocket(chatId)

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError: isMessagesError,
    error: messagesError,
    refetch,
  } = useInfiniteQuery({
    queryKey: ['messages', chatId],
    queryFn: async ({ pageParam }) => {
      const result = await getChatMessagesQuery({
        data: {
          chat_id: chatId,
          limit: 50,
          cursor: pageParam,
        },
      })
      if ('error' in result && !result.success) {
        throw new Error(result.error)
      }
      return result
    },
    initialPageParam: undefined as { sent_at: string; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  })
  useEffect(() => {
    if (isMessagesError) {
      toast.error(messagesError instanceof Error ? messagesError.message : 'Failed to load messages')
    }
  }, [isMessagesError, messagesError])

  const messages = useMemo(() => {
    if (!data?.pages) return []
    return data.pages.flatMap((page) => page.items).reverse()
  }, [data?.pages])

  const groupedMessages = useMemo(() => {
    const groups: {
      key: string
      label: string
      items: { message: (typeof messages)[number]; index: number }[]
    }[] = []

    messages.forEach((message, index) => {
      const createdAt = new Date(message.created_at)
      const dayKey = createdAt.toDateString()

      if (!groups.length || groups[groups.length - 1].key !== dayKey) {
        groups.push({
          key: dayKey,
          label: formatDate(createdAt, { mode: 'day-label' }),
          items: [],
        })
      }

      groups[groups.length - 1].items.push({ message, index })
    })

    return groups
  }, [messages])

  const readReceipts = useMemo<ChatReadReceipt[]>(() => {
    if (!data?.pages?.length) return []
    return data.pages[0]?.read_receipts ?? []
  }, [data?.pages])

  const readReceiptsMap = useMemo(() => {
    const receiptMap = new Map<string, ChatReadReceipt>()
    readReceipts.forEach((receipt) => {
      receiptMap.set(receipt.user_id, receipt)
    })
    return receiptMap
  }, [readReceipts])

  const messageOrderMap = useMemo(() => {
    const map = new Map<string, number>()
    messages.forEach((message, index) => {
      map.set(message.id, index)
    })
    return map
  }, [messages])

  const otherMemberIds = useMemo(() => {
    return members.filter((member) => member.id !== currentUserId).map((member) => member.id)
  }, [members, currentUserId])

  const { scrollToBottom, scrollAreaRef, isAtBottom } = useScroll(messages, typingUsers)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const readObserverRef = useRef<IntersectionObserver | null>(null)
  const latestAckedMessageIdRef = useRef<string | null>(null)
  const latestAckedOrderRef = useRef(-1)

  const sendReadReceipt = useCallback(
    (messageId: string) => {
      const sent = send('message_read', {
        chat_id: chatId,
        message_id: messageId,
      })

      // Only reset the unread badge when the receipt actually went out; a
      // queued receipt may be discarded before delivery. The server echoes
      // message_read back to us, which is the authoritative reset.
      if (!sent) return

      queryClient.setQueryData<ChatInfo[]>(['chats'], (oldChats) => {
        if (!oldChats) return oldChats

        return oldChats.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                unread_count: 0,
              }
            : chat
        )
      })
    },
    [chatId, send, queryClient]
  )

  const maybeMarkMessageRead = useCallback(
    (messageId: string) => {
      const candidateIndex = messageOrderMap.get(messageId)
      if (candidateIndex === undefined) return
      if (latestAckedMessageIdRef.current === messageId) return
      if (candidateIndex <= latestAckedOrderRef.current) return

      latestAckedMessageIdRef.current = messageId
      latestAckedOrderRef.current = candidateIndex
      sendReadReceipt(messageId)
    },
    [messageOrderMap, sendReadReceipt]
  )

  const getReceiptState = useCallback(
    (message: Message): ReadReceiptState | undefined => {
      if (message.sender_id !== currentUserId) return undefined
      if (otherMemberIds.length === 0) return undefined

      const messageTimestamp = new Date(message.created_at).getTime()
      const isRead = otherMemberIds.every((memberId) => {
        const receipt = readReceiptsMap.get(memberId)
        if (!receipt) return false

        const lastReadTimestamp = new Date(receipt.last_read_at).getTime()
        if (lastReadTimestamp > messageTimestamp) return true
        if (lastReadTimestamp === messageTimestamp) {
          return receipt.last_read_message_id === message.id
        }
        return false
      })

      return isRead ? 'read' : 'unread'
    },
    [currentUserId, otherMemberIds, readReceiptsMap]
  )

  useEffect(() => {
    latestAckedMessageIdRef.current = null
    latestAckedOrderRef.current = -1
  }, [chatId])

  // Intersection observer for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { threshold: 1.0 }
    )

    if (observerTarget.current) {
      observer.observe(observerTarget.current)
    }

    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
    if (!viewport) return

    if (readObserverRef.current) {
      readObserverRef.current.disconnect()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const target = entry.target as HTMLElement
          const messageId = target.dataset.messageId
          if (messageId) {
            maybeMarkMessageRead(messageId)
          }
        })
      },
      { root: viewport, threshold: 0.75 }
    )

    readObserverRef.current = observer

    Object.values(messageRefs.current).forEach((node) => {
      if (node) {
        observer.observe(node)
      }
    })

    return () => observer.disconnect()
  }, [messages, maybeMarkMessageRead, scrollAreaRef])

  useEffect(() => {
    if (!isAtBottom) return
    const latestMessage = messages[messages.length - 1]
    if (latestMessage) {
      maybeMarkMessageRead(latestMessage.id)
    }
  }, [isAtBottom, messages, maybeMarkMessageRead])

  const handleReplyJump = (messageId: string) => {
    const targetRef = messageRefs.current[messageId]
    if (targetRef) {
      targetRef.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(messageId)
      setTimeout(() => {
        setHighlightedMessageId((current) => (current === messageId ? null : current))
      }, 1500)
    }
  }
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)

  const isSameDay = (dateA: Date, dateB: Date) => dateA.toDateString() === dateB.toDateString()

  const getTimeDiffMinutes = (dateA: Date, dateB: Date) => {
    return Math.abs(dateA.getTime() - dateB.getTime()) / 1000 / 60
  }

  // Helper function to determine if a message should show header info
  const shouldShowHeader = (currentIndex: number) => {
    if (currentIndex === 0) return true

    const currentMsg = messages[currentIndex]
    const previousMsg = messages[currentIndex - 1]
    if (!previousMsg) return true

    const currentDate = new Date(currentMsg.created_at)
    const previousDate = new Date(previousMsg.created_at)

    if (!isSameDay(currentDate, previousDate)) return true

    // Different sender = new group
    if (currentMsg.sender_id !== previousMsg.sender_id) return true

    // Time gap > 2 minutes = new group
    const timeDiffMinutes = getTimeDiffMinutes(currentDate, previousDate)

    return timeDiffMinutes > 2
  }

  const isChainedWithPrevious = (currentIndex: number) => {
    if (currentIndex === 0) return false

    const currentMsg = messages[currentIndex]
    const previousMsg = messages[currentIndex - 1]
    if (!previousMsg) return false

    const currentDate = new Date(currentMsg.created_at)
    const previousDate = new Date(previousMsg.created_at)

    if (!isSameDay(currentDate, previousDate)) return false
    if (currentMsg.sender_id !== previousMsg.sender_id) return false

    return getTimeDiffMinutes(currentDate, previousDate) <= 2
  }

  const typingLabel = (() => {
    if (typingUsers.length === 0) return ''
    if (!isGroupChat) return 'typing...'
    if (typingUsers.length === 1) return `${typingUsers[0].username} is typing...`
    if (typingUsers.length === 2) {
      const secondUser = typingUsers[1] ?? typingUsers[0]
      return `${typingUsers[0].username} and ${secondUser.username} are typing...`
    }
    return `${typingUsers[0].username} and ${typingUsers.length - 1} others are typing...`
  })()

  return (
    <ScrollArea ref={scrollAreaRef} className="relative min-h-0 flex-1">
      <div className="mb-4 flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {hasNextPage && (
          <div ref={observerTarget} className="flex justify-center py-2">
            {isFetchingNextPage && <Loader2Icon className="text-muted-foreground size-5 animate-spin" />}
          </div>
        )}

        {isMessagesError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <div className="flex items-center justify-between gap-3">
              <span>Failed to load messages.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => refetch()}
                className="text-destructive hover:text-destructive"
              >
                Retry
              </Button>
            </div>
          </div>
        )}

        {groupedMessages.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <div className="flex justify-center">
              <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                {group.label}
              </span>
            </div>
            <div className="flex flex-col">
              {group.items.map(({ message: m, index }, itemIndex) => {
                const isOwn = m.sender_id === currentUserId
                const showHeader = shouldShowHeader(index)
                const isChained = isChainedWithPrevious(index)
                const marginTopClass = itemIndex === 0 ? 'mt-2' : isChained ? 'mt-1' : 'mt-3'
                const receiptState = getReceiptState(m)

                return (
                  <div
                    key={m.id}
                    className={marginTopClass}
                    data-message-id={m.id}
                    ref={(node) => {
                      if (node) {
                        messageRefs.current[m.id] = node
                      } else {
                        delete messageRefs.current[m.id]
                      }
                    }}
                  >
                    <div className={cn('flex w-full', isOwn ? 'justify-end' : 'justify-start')}>
                      {isOwn ? (
                        <div className="flex max-w-[75%] flex-col gap-1">
                          <MessageContent
                            message={m}
                            isOwn={true}
                            readReceiptState={receiptState}
                            onReply={onReplySelect}
                            onReplyJump={handleReplyJump}
                            isHighlighted={highlightedMessageId === m.id}
                          />
                        </div>
                      ) : (
                        <div className="flex max-w-[75%] items-end gap-2.5">
                          {isGroupChat && (
                            <div className="flex w-10 shrink-0 flex-col justify-end self-stretch">
                              {showHeader && (
                                <div className="flex justify-center">
                                  <UserAvatar
                                    username={m.sender_username}
                                    image={m.sender_profile_image_url}
                                    className="h-9 w-9"
                                  />
                                </div>
                              )}
                            </div>
                          )}
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            {showHeader && isGroupChat && (
                              <div className="flex items-center gap-2 px-1">
                                <span className="text-sm font-medium">{m.sender_username}</span>
                              </div>
                            )}
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <MessageContent
                                message={m}
                                isOwn={false}
                                readReceiptState={receiptState}
                                onReply={onReplySelect}
                                onReplyJump={handleReplyJump}
                                isHighlighted={highlightedMessageId === m.id}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {typingUsers.length > 0 && (
          <div className="flex w-full justify-start">
            <div className="flex max-w-[75%] items-end gap-2.5">
              {isGroupChat && (
                <div className="flex w-10 shrink-0 flex-col justify-end self-stretch">
                  <div className="flex justify-center">
                    <UserAvatar
                      username={typingUsers[0]?.username ?? 'Typing'}
                      image={members.find((member) => member.id === typingUsers[0]?.user_id)?.profile_image_url}
                      className="h-9 w-9"
                    />
                  </div>
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {isGroupChat && (
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-sm font-medium">{typingUsers[0]?.username ?? 'Someone'}</span>
                  </div>
                )}
                <div className="flex w-fit flex-wrap items-center gap-3 rounded-2xl bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                  <span className="leading-tight">{typingLabel}</span>
                  <div className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-muted-foreground/60 opacity-80 animate-bounce" />
                    <span className="size-2 rounded-full bg-muted-foreground/60 opacity-80 animate-bounce [animation-delay:0.15s]" />
                    <span className="size-2 rounded-full bg-muted-foreground/60 opacity-80 animate-bounce [animation-delay:0.3s]" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {!isAtBottom && (
        <Button
          size="icon"
          variant="outline"
          className="absolute bottom-3 left-[50%] translate-x-[-50%] rounded-full bg-background!"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon className="size-5" />
        </Button>
      )}
    </ScrollArea>
  )
}
