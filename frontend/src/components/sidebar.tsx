import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'

import { Avatar } from '@/components/avatar'
import { Logo } from '@/components/logo'
import { NewChat } from '@/components/new-chat'
import { inboxQuery } from '@/lib/api'
import { authClient, sessionQuery, unwrap, type Session } from '@/lib/auth'
import { formatShort } from '@/lib/time'

export function Sidebar({ user, className }: { user: Session['user']; className?: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const inbox = useQuery(inboxQuery)
  const [search, setSearch] = useState('')

  const signOut = useMutation({
    mutationFn: () => unwrap(authClient.signOut()),
    onSuccess: async () => {
      queryClient.clear()
      queryClient.setQueryData(sessionQuery.queryKey, null)
      await navigate({ to: '/login', search: { mode: 'signin' } })
    },
  })

  const query = search.trim().toLowerCase()
  const items = (inbox.data ?? []).filter(
    (i) => !query || i.peer.name.toLowerCase().includes(query) || i.peer.username.includes(query)
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
            <Avatar id={item.peer.id} name={item.peer.name} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] leading-[18px] font-semibold group-data-[status=active]:text-paper">
                {item.peer.name}
              </span>
              <span className="truncate text-sm leading-[18px] text-muted-foreground group-data-[status=active]:text-paper/65">
                {item.preview
                  ? `${item.preview.sender === user.id ? 'You: ' : ''}${item.preview.body}`
                  : `@${item.peer.username}`}
              </span>
            </div>
            <span className="shrink-0 self-start pt-0.5 text-right text-xs whitespace-nowrap text-muted-foreground group-data-[status=active]:text-paper/65">
              {item.preview && formatShort(item.updatedAt)}
            </span>
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-line px-2.5 py-3">
        <Avatar id={user.id} name={user.name} className="size-9 rounded-full text-[15px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{user.name}</span>
          <span className="truncate text-[13px] text-muted-foreground">@{user.displayUsername ?? user.username}</span>
        </div>
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
