import { queryOptions } from '@tanstack/react-query'

// Signed-in pages talk to Better Auth's endpoints directly; its full client only loads on /login (lib/auth).
export type Session = {
  user: { id: string; name: string; email: string; username?: string | null; displayUsername?: string | null }
}

// The last known session, so a reload renders the app from the local copy without waiting for the network.
// The server still checks the cookie on every request; this only decides what to render first.
const KEY = 'bubbles:session'

function remember(session: Session | null) {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the app still works, it just waits for the network on start.
  }
}

function remembered(): Session | undefined {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Session) : undefined
  } catch {
    return undefined
  }
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const res = await fetch('/api/auth/get-session')
    if (!res.ok) throw new Error('Could not load your session')
    const session = (await res.json()) as Session | null
    remember(session)
    return session
  },
  // Stale from the start, so it is checked against the server in the background.
  initialData: remembered,
  initialDataUpdatedAt: 0,
  staleTime: 60_000,
})

export async function signOut() {
  const res = await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error('Could not sign out')
  remember(null)
}
