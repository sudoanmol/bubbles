import { useMutation } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { Button } from '#/components/button'
import { Logo } from '#/components/logo'
import { authClient, sessionQuery, unwrap } from '#/lib/auth'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (!session) throw redirect({ to: '/login', search: { mode: 'signin' } })
    if (!session.user.username) throw redirect({ to: '/login/username' })
    return { user: session.user }
  },
  component: Home,
})

function Home() {
  const { user, queryClient } = Route.useRouteContext()
  const navigate = useNavigate()

  const signOut = useMutation({
    mutationFn: () => unwrap(authClient.signOut()),
    onSuccess: async () => {
      queryClient.setQueryData(sessionQuery.queryKey, null)
      await navigate({ to: '/login', search: { mode: 'signin' } })
    },
  })

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-[360px] shrink-0 flex-col gap-5 border-r border-line px-4 py-6 md:flex">
        <div className="flex items-center justify-between px-2">
          <Logo />
          <button
            aria-label="New chat"
            className="flex size-10 cursor-pointer items-center justify-center rounded-xl border-2 border-ink bg-sun shadow-[2px_2px_0_var(--color-ink)] transition-[translate,box-shadow] duration-100 active:translate-0.5 active:shadow-none"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="flex h-11 items-center gap-2.5 rounded-xl bg-wash px-3.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-muted)"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            aria-label="Search chats"
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
        </div>
        <p className="flex-1 px-2.5 py-3 text-sm leading-5 text-muted">
          No chats yet. Hit the <span className="font-semibold text-ink">+</span> to start one.
        </p>
        <div className="flex items-center gap-3 border-t border-line px-2.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-mint font-display text-[15px] font-extrabold text-paper uppercase">
            {user.username?.[0]}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{user.name}</span>
            <span className="truncate text-[13px] text-muted">@{user.displayUsername ?? user.username}</span>
          </div>
          <button
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className="cursor-pointer text-[13px] font-semibold text-muted hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-wash px-4">
        <div className="flex flex-col items-center gap-2.5">
          <div className="-rotate-4 rounded-[22px_22px_22px_6px] border-2 border-ink bg-paper px-[18px] py-3 font-medium shadow-sticker">
            hello?
          </div>
          <div className="rotate-3 rounded-[22px_22px_6px_22px] border-2 border-ink bg-sun px-[18px] py-3 font-medium shadow-sticker">
            is this thing on?
          </div>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="font-display text-[40px] leading-[44px] font-extrabold tracking-[-0.03em]">
            It's quiet in here
          </h1>
          <p className="text-base leading-6 text-muted">Start a chat with a friend by their username.</p>
        </div>
        <Button className="h-[52px]">Start a chat</Button>
        <button
          onClick={() => signOut.mutate()}
          className="cursor-pointer text-sm font-semibold text-muted hover:text-ink md:hidden"
        >
          Sign out
        </button>
      </main>
    </div>
  )
}
