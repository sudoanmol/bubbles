import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useMatch, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Sidebar } from '@/components/sidebar'
import { hydrateInbox } from '@/lib/api'
import { sessionQuery } from '@/lib/session'
import { connect } from '@/lib/socket'
import { openStore } from '@/lib/store'

/** Signed-in shell: the inbox beside the open chat, and the device's one socket. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context: { queryClient } }) => {
    // The remembered session renders the app at once; the server's answer arrives in the background.
    const session = await queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true })
    if (!session) throw redirect({ to: '/login', search: { mode: 'signin' } })
    if (!session.user.username) throw redirect({ to: '/login/username' })
    openStore(session.user.id)
    await hydrateInbox(queryClient)
    return { user: session.user }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user, queryClient } = Route.useRouteContext()
  const router = useRouter()
  const inChat = useMatch({ from: '/_app/c/$chatId', shouldThrow: false })
  const session = useQuery(sessionQuery)

  useEffect(() => connect(queryClient), [queryClient])

  // Signed out elsewhere, or the session expired: run the guard again, which sends us to /login.
  useEffect(() => {
    if (session.data === null) void router.invalidate()
  }, [session.data, router])

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
