import { useWebSocket } from '@/contexts/websocket-context'
import { createChatFn, searchUsersFn } from '@/server/chat'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useDebounceCallback } from 'usehooks-ts'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { UserAvatar } from './user-avatar'

export function NewChatDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user } = useRouteContext({ from: '__root__' })
  const { joinChat } = useWebSocket()
  const searchUsersQuery = useServerFn(searchUsersFn)
  const createChatMutation = useServerFn(createChatFn)

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<{ id: string; username: string }[]>([])
  const [showGroupNameInput, setShowGroupNameInput] = useState(false)
  const [groupName, setGroupName] = useState('')

  const debouncedSetQuery = useDebounceCallback(setDebouncedQuery, 300)

  const { data, isLoading: isSearching } = useQuery({
    queryKey: ['searchUsers', debouncedQuery, selectedUsers.map((u) => u.id)],
    queryFn: async () => {
      if (!debouncedQuery || !user) return []
      const result = await searchUsersQuery({
        data: {
          query: debouncedQuery,
          selected_user_ids: [user.id, ...selectedUsers.map((u) => u.id)],
        },
      })
      if (!result.success) {
        toast.error(result.error || 'Failed to search users')
        return []
      }
      return result.users
    },
    enabled: debouncedQuery.length > 0,
  })

  const searchResults = data || []

  const handleUserSelect = (userId: string, username: string) => {
    setSelectedUsers((prev) => [...prev, { id: userId, username }])
    setSearchQuery('')
    setDebouncedQuery('')
  }

  const handleUserRemove = (userId: string) => {
    setSelectedUsers((prev) => prev.filter((user) => user.id !== userId))
  }

  const { mutateAsync: createChat, isPending: isCreatingChat } = useMutation({
    mutationFn: createChatMutation,
    onSuccess: (result) => {
      if (result.success && result.data) {
        if (result.data.existing) {
          toast.error('Chat already exists')
        } else {
          toast.success('Chat created')
        }

        queryClient.invalidateQueries({ queryKey: ['chats'] })

        // Join the chat via WebSocket (works for both new and existing chats)
        joinChat(result.data.chat_id)

        navigate({ to: `/chats/${result.data.chat_id}` })

        setSelectedUsers([])
        setGroupName('')
        setShowGroupNameInput(false)
        setSearchQuery('')
        onOpenChange(false)
      } else {
        toast.error(result.error || 'Failed to create chat')
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to create chat')
    },
  })

  // After all hooks so the hook order is stable across renders
  if (!user) return null

  const handleStartNewChat = async () => {
    if (selectedUsers.length >= 2 && !showGroupNameInput) {
      setShowGroupNameInput(true)
      return
    }

    await createChat({
      data: {
        member_ids: [user.id, ...selectedUsers.map((user) => user.id)],
        group_name: groupName,
      },
    })
  }

  const handleBack = () => {
    setShowGroupNameInput(false)
    setGroupName('')
  }

  const handleDialogOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) {
      // Reset everything when dialog closes
      setSelectedUsers([])
      setGroupName('')
      setShowGroupNameInput(false)
      setSearchQuery('')
      setDebouncedQuery('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{showGroupNameInput ? 'Create Group Chat' : 'Start New Chat'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!showGroupNameInput ? (
            <>
              {/* Search Input */}
              <div className="space-y-2">
                <Input
                  placeholder="Search for users..."
                  value={searchQuery}
                  onChange={(e) => {
                    const value = e.target.value
                    setSearchQuery(value)
                    debouncedSetQuery(value.trim())
                  }}
                  autoFocus
                />
              </div>

              {selectedUsers.length > 0 && (
                <div className="space-y-2">
                  <div className="text-muted-foreground text-sm font-medium">Selected ({selectedUsers.length})</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedUsers.map((user) => (
                      <div key={user.id} className="bg-muted flex items-center gap-2 rounded-md px-2 py-1 text-sm">
                        <span>{user.username}</span>
                        <button
                          onClick={() => handleUserRemove(user.id)}
                          className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {searchQuery && (
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {isSearching ? (
                    <div className="text-muted-foreground py-2 text-center text-sm">Searching...</div>
                  ) : searchResults.length > 0 ? (
                    searchResults.map((user) => (
                      <Button
                        variant="ghost"
                        key={user.id}
                        onClick={() => handleUserSelect(user.id, user.username)}
                        className="hover:bg-muted flex w-full justify-start rounded-md px-2 transition-colors"
                        size="lg"
                      >
                        <UserAvatar username={user.username} image={user.profile_image_url} className="size-8" />
                        <span className="text-sm font-medium">{user.username}</span>
                      </Button>
                    ))
                  ) : (
                    <div className="text-muted-foreground py-2 text-center text-sm">No users found</div>
                  )}
                </div>
              )}
            </>
          ) : (
            /* Group Name Input */
            <div className="space-y-2">
              <div className="relative">
                <Input
                  placeholder="Enter group name..."
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  maxLength={20}
                  autoFocus
                  className="pr-12"
                />
                <div className="text-muted-foreground absolute top-1/2 right-3 -translate-y-1/2 text-xs">
                  {groupName.length}/20
                </div>
              </div>
            </div>
          )}
        </div>

        {selectedUsers.length > 0 && (
          <div className={`flex items-center ${showGroupNameInput ? 'justify-between' : 'justify-end'} pt-4`}>
            {showGroupNameInput && (
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 size-4" />
                Back
              </Button>
            )}
            <Button onClick={handleStartNewChat} disabled={showGroupNameInput && !groupName.trim()}>
              {isCreatingChat
                ? 'Creating chat...'
                : showGroupNameInput
                  ? 'Create Group Chat'
                  : selectedUsers.length > 1
                    ? 'Continue'
                    : 'Start New Chat'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
