import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { InboxItem } from 'backend/protocol'
import { cn } from 'cn'
import { MonitorIcon, MoonIcon, SearchIcon, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { lazy, Suspense, useState } from 'react'

import { Avatar } from '@/components/avatar'
import { Logo } from '@/components/logo'
import { NewChat } from '@/components/new-chat'
import { inboxQuery } from '@/lib/api'
import { describeText, firstName } from '@/lib/group-events'
import { sessionQuery, signOut as requestSignOut, type Session } from '@/lib/session'
import { deleteStore } from '@/lib/store'
import { formatShort } from '@/lib/time'
import { useTyping } from '@/lib/typing'

export function Sidebar({ user, className }: { user: Session['user']; className?: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const inbox = useQuery(inboxQuery)
  const typing = useTyping()
  const [search, setSearch] = useState('')

  const signOut = useMutation({
    mutationFn: requestSignOut,
    onSuccess: async () => {
      // Nothing of this account stays on the device. Not awaited: another tab can hold the deletion up for a moment.
      void deleteStore()
      queryClient.clear()
      queryClient.setQueryData(sessionQuery.queryKey, null)
      await navigate({ to: '/login', search: { mode: 'signin' } })
    },
  })

  const query = search.trim().toLowerCase()

  const items = (inbox.data ?? []).filter(
    (i) =>
      !query ||
      (i.kind === 'dm'
        ? i.peer.name.toLowerCase().includes(query) || i.peer.username.includes(query)
        : i.name.toLowerCase().includes(query))
  )

  return (
    <aside className={`w-full shrink-0 flex-col gap-5 border-r border-line px-4 pt-6 md:w-[360px] ${className}`}>
      <div className="flex items-center justify-between px-2">
        <Link to="/" aria-label="Bubbles home" className="rounded-lg">
          <Logo />
        </Link>
        <NewChat variant="icon" />
      </div>

      <label className="flex h-11 shrink-0 items-center gap-2.5 rounded-xl bg-wash px-3.5">
        <SearchIcon className="size-4 text-muted-foreground" strokeWidth={2.5} aria-hidden="true" />
        <input
          aria-label="Search chats"
          placeholder="Search chats"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        />
      </label>

      <nav aria-label="Chats" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {inbox.isSuccess && items.length === 0 && (
          <p className="px-2.5 py-3 text-sm leading-5 text-muted-foreground">
            {query ? 'No chats match that.' : 'No chats yet. Hit the + to start one.'}
          </p>
        )}
        {items.map((item) => (
          <Link
            key={item.chatId}
            to="/c/$chatId"
            params={{ chatId: item.chatId }}
            className="group flex items-center gap-3 rounded-[14px] p-2.5 transition-colors hover:bg-wash data-[status=active]:bg-ink"
          >
            {/* A group you're no longer in fades (Paper: "Groups: receipts, leaving, deleting"). */}
            <Avatar
              id={item.kind === 'dm' ? item.peer.id : item.chatId}
              image={item.kind === 'dm' ? item.peer.image : null}
              className={cn(item.kind === 'group' && !item.active && 'opacity-45')}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] leading-[18px] font-semibold group-data-[status=active]:text-paper">
                {title(item)}
              </span>
              <span
                className={cn(
                  'truncate text-sm leading-[18px] text-muted-foreground group-data-[status=active]:text-paper/65',
                  item.unread > 0 && 'font-medium text-ink',
                  typing[item.chatId]?.length && 'font-medium text-cobalt'
                )}
              >
                {typing[item.chatId]?.length ? 'typing…' : preview(item, user.id)}
              </span>
            </div>
            <div className="flex w-11 shrink-0 flex-col items-end gap-1.5 self-start pt-0.5">
              <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground group-data-[status=active]:text-paper/65">
                {item.preview && formatShort(item.updatedAt)}
              </span>
              {/* Paper: "/ (home)". The open chat is being read, so it never shows a count. */}
              {item.unread > 0 && (
                <span
                  aria-label={`${item.unread} unread`}
                  className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full border-[1.5px] border-ink bg-sun px-[7px] text-xs leading-4 font-bold text-black group-data-[status=active]:hidden"
                >
                  {item.unread > 99 ? '99+' : item.unread}
                </span>
              )}
            </div>
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-line px-2.5 py-3">
        <ProfileButton user={user} />
        <ThemeButton />
        <button
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="text-[13px] font-semibold text-muted-foreground hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}

// The dialog pulls in the auth client and Base UI's Menu, so it loads on first hover or focus.
const loadProfile = () => import('@/components/profile-dialog')
const ProfileDialog = lazy(loadProfile)

/** You, at the bottom of the sidebar: the whole row opens your profile (Paper: "Profile"). */
function ProfileButton({ user }: { user: Session['user'] }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label="Edit profile"
        onPointerEnter={() => void loadProfile()}
        onFocus={() => void loadProfile()}
        onClick={() => {
          setLoaded(true)
          setOpen(true)
        }}
        className="group/profile -m-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-wash"
      >
        <Avatar id={user.id} image={user.image} className="size-9" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm leading-[18px] font-semibold">{user.name}</span>
          <span className="truncate text-[13px] leading-4 text-muted-foreground group-hover/profile:hidden">
            @{user.displayUsername ?? user.username}
          </span>
          <span className="hidden text-[13px] leading-4 text-muted-foreground group-hover/profile:block">
            Edit profile
          </span>
        </span>
      </button>
      {loaded && (
        <Suspense>
          <ProfileDialog user={user} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}

const themes = {
  system: { next: 'light', label: 'Theme: same as device', Icon: MonitorIcon },
  light: { next: 'dark', label: 'Theme: light', Icon: SunIcon },
  dark: { next: 'system', label: 'Theme: dark', Icon: MoonIcon },
} as const

/** Cycles device → light → dark. */
function ThemeButton() {
  const { theme, setTheme } = useTheme()
  const { next, label, Icon } = theme === 'light' || theme === 'dark' ? themes[theme] : themes.system

  return (
    <button
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-wash hover:text-ink"
    >
      <Icon className="size-4" strokeWidth={2.5} aria-hidden="true" />
    </button>
  )
}

const title = (item: InboxItem) => (item.kind === 'dm' ? item.peer.name : item.name)

/** The line under a chat's name: its newest message or group event, and who it's from. */
function preview(item: InboxItem, uid: string) {
  const p = item.preview

  if (!p) return item.kind === 'dm' ? `@${item.peer.username}` : ''

  if (p.kind === 'system') return describeText(p.body, uid)
  const from = p.sender === uid ? 'You' : firstName(item.kind === 'dm' ? item.peer.name : (p.name ?? 'Someone'))

  if (p.deleted) return `${from} deleted a message`

  return item.kind === 'group' || p.sender === uid ? `${from}: ${p.body}` : p.body
}
