import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Chat } from 'backend/protocol'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { deleteChat } from '@/lib/api'
import { firstName } from '@/lib/group-events'

/**
 * Takes the composer's place once you're out of a group: why, and Delete chat to drop it from your list
 * (Paper: "Groups: receipts, leaving, deleting"). Loaded only for
 * someone out of the group.
 */
export default function LeftGroupBar({ chat, uid }: { chat: Chat; uid: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const by = chat.members.find((m) => m.id === chat.group?.leftBy)
  const who = by ? firstName(by.name) : 'Someone'
  const reason = chat.group?.deleted
    ? `${by?.id === uid ? 'You' : who} deleted the group`
    : by?.id === uid
      ? 'You left this group'
      : `${who} removed you`

  return (
    <div className="shrink-0 px-4 pt-2 pb-4 md:px-7 md:pb-6">
      <div className="flex min-h-14 items-center justify-center gap-3.5 rounded-[28px] border-[1.5px] border-line bg-paper px-5">
        <span className="text-[15px] text-muted-foreground">{reason}</span>
        <Button variant="outline" size="sm" className="rounded-full text-danger" onClick={() => setConfirming(true)}>
          Delete chat
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this chat?"
        description={`${chat.group?.name ?? 'This chat'} and its messages are removed from your chats and this device.`}
        action="Delete chat"
        onConfirm={async () => {
          await deleteChat(queryClient, chat.id)
          await navigate({ to: '/' })
        }}
      />
    </div>
  )
}
