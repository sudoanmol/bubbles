import { useWebSocket } from '@/contexts/websocket-context'
import {
  addChatMemberFn,
  changeChatAdminFn,
  clearChatFn,
  deleteChatFn,
  leaveChatFn,
  removeChatMemberFn,
  renameChatFn,
  searchUsersFn,
} from '@/server/chat'
import type { ChatInfo, ChatMember, ChatUser } from '@/types/chat'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { EraserIcon, LogOutIcon, PencilIcon, ShieldIcon, Trash2Icon, UserMinusIcon, UserPlusIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useDebounceCallback } from 'usehooks-ts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { ScrollArea } from './ui/scroll-area'
import { UserAvatar } from './user-avatar'

type ConfirmableAction = 'clear' | 'delete' | 'leave' | null

type ChatActionsProps = {
  chat: ChatInfo
  currentUserId: string
  isActive: boolean
  onChatRemoved?: () => void
  children: React.ReactNode
}

export function ChatActions({ chat, currentUserId, isActive, onChatRemoved, children }: ChatActionsProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { leaveChat } = useWebSocket()
  const [confirmAction, setConfirmAction] = useState<ConfirmableAction>(null)
  const [isRenameOpen, setIsRenameOpen] = useState(false)
  const [isMembersOpen, setIsMembersOpen] = useState(false)
  const [isChangeAdminOpen, setIsChangeAdminOpen] = useState(false)
  const [groupName, setGroupName] = useState(chat.name ?? '')
  const [members, setMembers] = useState<ChatMember[]>(chat.members)
  const [memberSearch, setMemberSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debouncedSetSearch = useDebounceCallback(setDebouncedSearch, 300)

  const isGroupChat = chat.is_group
  const isCreator = chat.creator_id === currentUserId
  const canDeleteChat = !isGroupChat || isCreator
  const canManageMembers = isGroupChat && isCreator
  const canLeaveChat = isGroupChat && !isCreator

  const clearChatServerFn = useServerFn(clearChatFn)
  const deleteChatServerFn = useServerFn(deleteChatFn)
  const leaveChatServerFn = useServerFn(leaveChatFn)
  const renameChatServerFn = useServerFn(renameChatFn)
  const addMemberServerFn = useServerFn(addChatMemberFn)
  const removeMemberServerFn = useServerFn(removeChatMemberFn)
  const changeAdminServerFn = useServerFn(changeChatAdminFn)
  const searchUsersServerFn = useServerFn(searchUsersFn)

  useEffect(() => {
    setGroupName(chat.name ?? '')
  }, [chat.name])

  useEffect(() => {
    setMembers(chat.members)
  }, [chat.members])

  useEffect(() => {
    if (!isMembersOpen) {
      setMemberSearch('')
      setDebouncedSearch('')
    }
  }, [isMembersOpen])

  const { data: searchResults = [], isFetching: isSearching } = useQuery({
    queryKey: ['search-users', chat.id, debouncedSearch, members.length],
    enabled: isMembersOpen && debouncedSearch.length > 0,
    queryFn: async () => {
      const response = await searchUsersServerFn({
        data: {
          query: debouncedSearch,
          selected_user_ids: [currentUserId, ...members.map((member) => member.id)],
        },
      })

      if (!response.success) {
        toast.error(response.error || 'Failed to search users')
        return []
      }

      return response.users
    },
  })

  const invalidateChatData = async (options?: { removeChat?: boolean }) => {
    await queryClient.invalidateQueries({ queryKey: ['chats'] })
    if (options?.removeChat) {
      queryClient.removeQueries({ queryKey: ['chat', chat.id] })
      queryClient.removeQueries({ queryKey: ['messages', chat.id] })
      return
    }
    await queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
  }

  const clearMessagesCache = () => {
    queryClient.invalidateQueries({ queryKey: ['messages', chat.id] })
  }

  const clearChatMutation = useMutation({
    mutationFn: async () => {
      const result = await clearChatServerFn({ data: { chatId: chat.id } })
      if (!result.success) {
        throw new Error(result.error || 'Failed to clear chat')
      }
      return result
    },
    onSuccess: async () => {
      toast.success('Chat cleared')
      clearMessagesCache()
      await invalidateChatData()
      setConfirmAction(null)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to clear chat')
    },
  })

  const deleteChatMutation = useMutation({
    mutationFn: async () => {
      const result = await deleteChatServerFn({ data: { chatId: chat.id } })
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete chat')
      }
      return result.data as { fully_deleted?: boolean }
    },
    onSuccess: async (data) => {
      const fullyDeleted = data?.fully_deleted ?? false
      toast.success(fullyDeleted ? 'Chat permanently deleted' : 'Chat removed')
      setConfirmAction(null)
      if (fullyDeleted) {
        leaveChat(chat.id)
      }
      await invalidateChatData({ removeChat: fullyDeleted })
      if (isActive) {
        void navigate({ to: '/chats' })
        onChatRemoved?.()
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to delete chat')
    },
  })

  const leaveChatMutation = useMutation({
    mutationFn: async () => {
      const result = await leaveChatServerFn({ data: { chatId: chat.id } })
      if (!result.success) {
        throw new Error(result.error || 'Failed to leave chat')
      }
      return result
    },
    onSuccess: async () => {
      toast.success('You left the chat')
      setConfirmAction(null)
      leaveChat(chat.id)
      await invalidateChatData({ removeChat: true })
      if (isActive) {
        void navigate({ to: '/chats' })
        onChatRemoved?.()
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to leave chat')
    },
  })

  const renameChatMutation = useMutation({
    mutationFn: async () => {
      const result = await renameChatServerFn({
        data: {
          chat_id: chat.id,
          name: groupName.trim(),
        },
      })
      if (!result.success) {
        throw new Error(result.error || 'Failed to rename chat')
      }
      return result
    },
    onSuccess: async () => {
      toast.success('Chat renamed')
      await invalidateChatData()
      setIsRenameOpen(false)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to rename chat')
    },
  })

  const addMemberMutation = useMutation({
    mutationFn: async (user: ChatUser) => {
      const result = await addMemberServerFn({
        data: {
          chat_id: chat.id,
          user_id: user.id,
        },
      })
      if (!result.success) {
        throw new Error(result.error || 'Failed to add member')
      }
      return user
    },
    onSuccess: async (user) => {
      toast.success(`${user.username} added`)
      setMembers((prev) => [
        ...prev,
        { id: user.id, username: user.username, profile_image_url: user.profile_image_url },
      ])
      await invalidateChatData()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to add member')
    },
  })

  const removeMemberMutation = useMutation({
    mutationFn: async (member: ChatMember) => {
      const result = await removeMemberServerFn({
        data: {
          chat_id: chat.id,
          user_id: member.id,
        },
      })
      if (!result.success) {
        throw new Error(result.error || 'Failed to remove member')
      }
      return member
    },
    onSuccess: async (member) => {
      toast.success(`${member.username} removed`)
      setMembers((prev) => prev.filter((existing) => existing.id !== member.id))
      await invalidateChatData()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove member')
    },
  })

  const changeAdminMutation = useMutation({
    mutationFn: async (member: ChatMember) => {
      const result = await changeAdminServerFn({
        data: {
          chat_id: chat.id,
          user_id: member.id,
        },
      })
      if (!result.success) {
        throw new Error(result.error || 'Failed to change admin')
      }
      return member
    },
    onSuccess: async (member) => {
      toast.success(`${member.username} is now the admin`)
      setIsChangeAdminOpen(false)
      await invalidateChatData()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to change admin')
    },
  })

  const isConfirmPending = clearChatMutation.isPending || deleteChatMutation.isPending || leaveChatMutation.isPending

  const canSubmitRename = useMemo(() => {
    const trimmed = groupName.trim()
    return trimmed.length >= 3 && trimmed.length <= 20 && trimmed !== (chat.name ?? '')
  }, [groupName, chat.name])

  const handleConfirmAction = () => {
    if (confirmAction === 'clear') {
      clearChatMutation.mutate()
    } else if (confirmAction === 'delete') {
      deleteChatMutation.mutate()
    } else if (confirmAction === 'leave') {
      leaveChatMutation.mutate()
    }
  }

  const renderConfirmCopy = () => {
    switch (confirmAction) {
      case 'clear':
        return {
          title: 'Clear chat history?',
          description: 'This only removes messages for you. Others will still see the conversation.',
          actionLabel: 'Clear chat',
        }
      case 'delete':
        return {
          title: isGroupChat ? 'Delete group chat?' : 'Delete chat?',
          description: isGroupChat
            ? 'This will permanently delete the group for everyone. This action cannot be undone.'
            : 'This removes the chat from your list. If the other person also deletes it, the chat will be erased.',
          actionLabel: isGroupChat ? 'Delete for everyone' : 'Delete chat',
        }
      case 'leave':
        return {
          title: 'Leave chat?',
          description: 'You will no longer receive messages from this group.',
          actionLabel: 'Leave chat',
        }
      default:
        return null
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-[200px]">
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setConfirmAction('clear')
            }}
          >
            <EraserIcon className="size-4" />
            Clear chat
          </ContextMenuItem>
          {canDeleteChat && (
            <ContextMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault()
                setConfirmAction('delete')
              }}
            >
              <Trash2Icon className="size-4" />
              Delete chat
            </ContextMenuItem>
          )}
          {isGroupChat && (
            <ContextMenuItem
              disabled={!canLeaveChat}
              onSelect={(event) => {
                event.preventDefault()
                if (canLeaveChat) {
                  setConfirmAction('leave')
                }
              }}
            >
              <LogOutIcon className="size-4" />
              Leave chat
            </ContextMenuItem>
          )}
          {isGroupChat && isCreator && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  setIsRenameOpen(true)
                }}
              >
                <PencilIcon className="size-4" />
                Rename chat
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  setIsMembersOpen(true)
                }}
              >
                <UserPlusIcon className="size-4" />
                Add / Remove members
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  setIsChangeAdminOpen(true)
                }}
              >
                <ShieldIcon className="size-4" />
                Change admin
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(open) => {
          if (!open && !isConfirmPending) {
            setConfirmAction(null)
          }
        }}
      >
        <AlertDialogContent>
          {renderConfirmCopy() ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{renderConfirmCopy()?.title}</AlertDialogTitle>
                <AlertDialogDescription>{renderConfirmCopy()?.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  disabled={isConfirmPending}
                  onClick={() => {
                    if (!isConfirmPending) setConfirmAction(null)
                  }}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction disabled={isConfirmPending} onClick={handleConfirmAction}>
                  {renderConfirmCopy()?.actionLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Set a new name for this group.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="relative">
              <Input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                maxLength={20}
                placeholder="Group name"
                className="pr-12"
              />
              <span className="text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2 text-xs">
                {groupName.trim().length}/20
              </span>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => renameChatMutation.mutate()}
                disabled={!canSubmitRename || renameChatMutation.isPending}
              >
                {renameChatMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isMembersOpen} onOpenChange={setIsMembersOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage members</DialogTitle>
            <DialogDescription>Remove existing members or invite new ones.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">Existing members</p>
              <div className="rounded-md border">
                <ScrollArea className="h-48">
                  <div className="divide-y">
                    {members.map((member) => (
                      <div key={member.id} className="flex items-center gap-3 px-3 py-2">
                        <UserAvatar username={member.username} image={member.profile_image_url} className="size-8" />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{member.username}</p>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {member.id === chat.creator_id ? 'Admin' : null}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            member.id === chat.creator_id || removeMemberMutation.isPending || !canManageMembers
                          }
                          onClick={() => removeMemberMutation.mutate(member)}
                        >
                          <UserMinusIcon className="mr-1 size-4" />
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>

            <div className="space-y-3">
              <Input
                placeholder="Search users to add..."
                value={memberSearch}
                onChange={(event) => {
                  const value = event.target.value
                  setMemberSearch(value)
                  debouncedSetSearch(value.trim())
                }}
              />
              <div className="min-h-[100px] rounded-md border">
                {memberSearch.trim().length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">Start typing to search for users.</div>
                ) : isSearching ? (
                  <div className="p-4 text-sm text-muted-foreground">Searching...</div>
                ) : searchResults.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">No users found.</div>
                ) : (
                  <ScrollArea className="max-h-48">
                    <div className="divide-y">
                      {searchResults.map((user) => (
                        <div key={user.id} className="flex items-center gap-3 px-3 py-2">
                          <UserAvatar username={user.username} image={user.profile_image_url} className="size-8" />
                          <div className="flex-1">
                            <p className="text-sm font-medium">{user.username}</p>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => addMemberMutation.mutate(user)}
                            disabled={addMemberMutation.isPending}
                          >
                            <UserPlusIcon className="mr-1 size-4" />
                            Add
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isChangeAdminOpen} onOpenChange={setIsChangeAdminOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change admin</DialogTitle>
            <DialogDescription>Select a new admin for this group.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-96">
            <div className="space-y-3">
              {members
                .filter((member) => member.id !== chat.creator_id)
                .map((member) => (
                  <div key={member.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <UserAvatar username={member.username} image={member.profile_image_url} className="size-8" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{member.username}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={changeAdminMutation.isPending}
                      onClick={() => changeAdminMutation.mutate(member)}
                    >
                      <ShieldIcon className="mr-1 size-4" />
                      Make admin
                    </Button>
                  </div>
                ))}
              {members.filter((member) => member.id !== chat.creator_id).length === 0 && (
                <p className="text-sm text-muted-foreground">No eligible members available.</p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
