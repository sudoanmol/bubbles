import { useChatListWebSocket } from '@/hooks/use-chat-websocket'
import { cn, formatDate } from '@/lib/utils'
import { logoutFn } from '@/server/auth'
import { getUserChatsFn } from '@/server/chat'
import type { ChatInfo } from '@/types/chat'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouteContext } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PenBoxIcon,
  SearchIcon,
  Settings2Icon,
  SunIcon,
  SunMoonIcon,
  TrashIcon,
  UserIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChatActions } from './chat-actions'
import { NewChatDialog } from './new-chat-dialog'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { UserAvatar } from './user-avatar'
import { UserSettingsDialog } from './user-settings-dialog'

const THEME_OPTIONS = [
  { label: 'Light', value: 'light', icon: SunIcon },
  { label: 'Dark', value: 'dark', icon: MoonIcon },
  { label: 'System', value: 'system', icon: MonitorIcon },
] as const

export function ChatsList() {
  const [search, setSearch] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const chatId = 'chatId' in params ? params.chatId : null
  const { user } = useRouteContext({ from: '__root__' })

  const logoutMutation = useServerFn(logoutFn)
  const getUserChatsQuery = useServerFn(getUserChatsFn)

  useChatListWebSocket(user?.id, chatId ?? undefined)

  const logout = useMutation({
    mutationFn: async () => {
      await logoutMutation()
    },
    onSuccess: () => {
      navigate({ to: '/auth' })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to log out')
    },
  })
  const { theme, setTheme } = useTheme()

  const {
    data: chats = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['chats'],
    queryFn: async () => {
      const result = await getUserChatsQuery()
      if ('error' in result && !result.success) {
        throw new Error(result.error)
      }
      return result.chats
    },
  })

  useEffect(() => {
    if (isError) {
      toast.error(error instanceof Error ? error.message : 'Failed to load chats')
    }
  }, [isError, error])

  const filteredChats = useMemo(() => {
    if (!search) return chats
    const searchLower = search.toLowerCase()

    return chats.filter((chat) => {
      const memberMatch = chat.members.some((member) => member.username.toLowerCase().includes(searchLower))

      if (chat.is_group && chat.name) {
        const nameMatch = chat.name.toLowerCase().includes(searchLower)
        return nameMatch || memberMatch
      }

      return memberMatch
    })
  }, [chats, search])

  const getOtherParticipant = (chat: (typeof chats)[0]) => {
    if (!user) return null
    return chat.members.find((member) => member.id !== user.id)
  }

  const getChatDisplayName = (chat: (typeof chats)[0]) => {
    if (chat.is_group) {
      return chat.name || 'Group Chat'
    }
    const otherParticipant = getOtherParticipant(chat)
    return otherParticipant?.username || 'Unknown'
  }

  // After all hooks so the hook order is stable across renders
  if (!user) {
    return null
  }

  const displayLastMessage = (chat: ChatInfo, currentUserId: string) => {
    const lastMessage = chat.last_message

    if (!lastMessage) {
      return 'Say hello 👋'
    }

    const isOwnMessage = lastMessage.sender?.id === currentUserId
    const senderName = isOwnMessage ? 'You' : lastMessage.sender?.username
    const isGroupChat = chat.is_group
    const senderPrefix = isGroupChat ? `${senderName}: ` : ''

    if (lastMessage.is_deleted) {
      return (
        <span className="flex items-center gap-1">
          <TrashIcon className="size-3.5 shrink-0" />
          <span>{isGroupChat ? `${senderName} deleted this message` : 'This message was deleted'}</span>
        </span>
      )
    }

    const imageCount = lastMessage.images?.length ?? 0

    if (!lastMessage.content || lastMessage.content.trim() === '') {
      const imageText = imageCount > 1 ? 'images' : 'an image'
      return `${senderPrefix}${isGroupChat ? 'Sent' : ''} ${imageText}`.trim()
    }

    if (!isGroupChat && isOwnMessage) {
      return `You: ${lastMessage.content}`
    }

    return `${senderPrefix}${lastMessage.content}`
  }

  return (
    <div className={cn(chatId ? 'hidden lg:block' : 'block', 'w-full shrink-0 lg:w-1/4')}>
      <div className="flex h-full flex-col gap-4 border-b border-border bg-background px-4 py-2 lg:border-b-0 lg:border-r">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <Link to="/chats" className="cursor-pointer text-lg font-medium">
              Chats
            </Link>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="outline" disabled={logout.isPending}>
                    <Settings2Icon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <SunMoonIcon className="size-4" />
                      <span>Toggle theme</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value)}>
                        {THEME_OPTIONS.map((option) => {
                          const Icon = option.icon
                          return (
                            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2">
                              <Icon className="size-4" />
                              <span>{option.label}</span>
                            </DropdownMenuRadioItem>
                          )
                        })}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault()
                      setIsSettingsOpen(true)
                    }}
                  >
                    <UserIcon className="size-4" />
                    <span>User settings</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={logout.isPending}
                    onSelect={() => {
                      void logout.mutateAsync()
                    }}
                  >
                    <LogOutIcon className="size-4" />
                    <span>Logout</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="icon-sm" variant="outline" onClick={() => setIsDialogOpen(true)}>
                <PenBoxIcon />
              </Button>
            </div>
          </div>

          <div className="relative">
            <SearchIcon className="absolute left-2 top-2 h-5 w-5 text-gray-400" />
            <Input
              placeholder="Search"
              className="w-full pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="flex h-full flex-col gap-1 overflow-y-auto">
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-3 w-32" />
                        <Skeleton className="h-3 w-12" />
                      </div>
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))
              : filteredChats.map((chat) => {
                  const otherParticipant = getOtherParticipant(chat)
                  const displayName = getChatDisplayName(chat)
                  const hasUnread = chat.unread_count > 0
                  const timestamp = formatDate(new Date(chat.last_message?.created_at ?? chat.updated_at))

                  return (
                    <ChatActions
                      key={chat.id}
                      chat={chat}
                      currentUserId={user.id}
                      isActive={chat.id === chatId}
                      onChatRemoved={() => {
                        if (chat.id === chatId) {
                          navigate({ to: '/chats' })
                        }
                      }}
                    >
                      <Link
                        to="/chats/$chatId"
                        params={{ chatId: chat.id }}
                        className={cn(
                          'block rounded-xs px-3 py-2 transition-colors hover:bg-primary/5',
                          chat.id === chatId && 'bg-primary/10 hover:bg-primary/10'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          {chat.is_group ? (
                            <UserAvatar username={displayName} className="size-10" />
                          ) : (
                            <UserAvatar
                              username={otherParticipant?.username || 'Unknown'}
                              image={otherParticipant?.profile_image_url}
                              className="size-10"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <div className="line-clamp-1 truncate font-medium">{displayName}</div>
                              <div className="ml-auto flex items-center gap-2">
                                <div className="shrink-0 text-xs text-muted-foreground">{timestamp}</div>
                                {hasUnread && (
                                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                                    {chat.unread_count > 99 ? '99+' : chat.unread_count}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div
                              className={cn(
                                'truncate text-sm',
                                hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'
                              )}
                            >
                              {displayLastMessage(chat, user.id)}
                            </div>
                          </div>
                        </div>
                      </Link>
                    </ChatActions>
                  )
                })}
          </div>
        </div>
      </div>

      <NewChatDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
      {user && <UserSettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} user={user} />}
    </div>
  )
}
