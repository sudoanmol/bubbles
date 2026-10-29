import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Chat, Profile } from 'backend/protocol'
import { ArrowLeftIcon, UsersIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { Avatar } from '@/components/avatar'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { presenceQuery } from '@/lib/api'
import { firstName } from '@/lib/group-events'
import { formatAgo } from '@/lib/time'

// Group settings (dialogs, menus, the people picker) load on first hover or focus of the header button.
const loadSettings = () => import('@/components/group-settings')
const GroupSettings = lazy(loadSettings)

/** The bar above a chat: who it's with, and for a group, who's in it and its settings (Paper: "Group chat"). */
export function ChatHeader({ chat, uid }: { chat: Chat; uid: string }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const peer = chat.members.find((m) => m.id !== uid) ?? chat.members[0]
  const preload = () => void loadSettings()

  return (
    <header className="flex h-[76px] shrink-0 items-center gap-3 border-b border-line bg-paper px-4 md:px-7">
      <Link to="/" aria-label="Back to chats" className="-ml-1 rounded-lg p-1 md:hidden">
        <ArrowLeftIcon className="size-5" />
      </Link>
      <Avatar
        id={chat.group ? chat.id : peer.id}
        name={chat.group?.name ?? peer.name}
        className="size-10 rounded-full text-base"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-5 font-semibold">{chat.group?.name ?? peer.name}</span>
        {chat.group ? (
          <span className="truncate text-[13px] leading-4 font-medium text-muted-foreground">
            {memberLine(chat, uid)}
          </span>
        ) : (
          <PresenceLine chatId={chat.id} peer={peer} />
        )}
      </div>
      {chat.group && (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Group settings"
            className="rounded-full bg-wash text-ink"
            onPointerEnter={preload}
            onFocus={preload}
            onClick={() => {
              setLoaded(true)
              setOpen(true)
            }}
          >
            <UsersIcon className="size-5" strokeWidth={2.25} />
          </Button>
          {loaded && (
            <Suspense>
              <GroupSettings chat={chat} uid={uid} open={open} onOpenChange={setOpen} />
            </Suspense>
          )}
        </>
      )}
    </header>
  )
}

/** "Maya, Leo and you"; past four names, "Maya, Leo, Sara and 12 others". */
function memberLine(chat: Chat, uid: string) {
  const inIt = chat.members.filter((m) => m.left === null)
  const names = inIt.filter((m) => m.id !== uid).map((m) => firstName(m.name))
  if (inIt.some((m) => m.id === uid)) names.push('you')
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} others`] : names
  return shown.length < 2 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** Online, or when they were last seen, under the name in a DM's header (Paper: "Typing & presence"). */
function PresenceLine({ chatId, peer }: { chatId: string; peer: Profile }) {
  const presence = useQuery(presenceQuery(chatId)).data?.[peer.id]
  const now = useNow(60_000)
  if (presence?.online) return <span className="text-[13px] leading-4 font-medium text-mint">online</span>
  return (
    <span className="truncate text-[13px] leading-4 font-medium text-muted-foreground">
      {presence?.lastSeen ? `active ${formatAgo(presence.lastSeen, now)}` : `@${peer.username}`}
    </span>
  )
}
