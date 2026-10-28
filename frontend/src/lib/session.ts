import { queryOptions } from '@tanstack/react-query'

// Signed-in pages talk to Better Auth's endpoints directly; its full client only loads on /login (lib/auth).
export type Session = {
  user: { id: string; name: string; email: string; username?: string | null; displayUsername?: string | null }
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const res = await fetch('/api/auth/get-session')
    if (!res.ok) throw new Error('Could not load your session')
    return (await res.json()) as Session | null
  },
  staleTime: 60_000,
})

export async function signOut() {
  const res = await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error('Could not sign out')
}
