import { createFileRoute, Outlet, redirect, useMatch } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Sidebar } from '@/components/sidebar'
import { sessionQuery } from '@/lib/session'
import { connect } from '@/lib/socket'

/** Signed-in shell: the inbox beside the open chat, and the device's one socket. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (!session) throw redirect({ to: '/login', search: { mode: 'signin' } })
    if (!session.user.username) throw redirect({ to: '/login/username' })
    return { user: session.user }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user, queryClient } = Route.useRouteContext()
  const inChat = useMatch({ from: '/_app/c/$chatId', shouldThrow: false })

  useEffect(() => connect(queryClient), [queryClient])

  return (
    <div className="flex h-dvh">
      {/* On phones the inbox and the chat each take the full screen. */}
      <Sidebar user={user} className={inChat ? 'hidden md:flex' : 'flex'} />
      <main className={`min-w-0 flex-1 flex-col bg-wash ${inChat ? 'flex' : 'hidden md:flex'}`}>
        <Outlet />
      </main>
    </div>
  )
}
