import { queryOptions } from '@tanstack/react-query'
import { usernameClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ plugins: [usernameClient()] })

export type Session = typeof authClient.$Infer.Session

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const { data, error } = await authClient.getSession()
    if (error) throw error
    return data
  },
  staleTime: 60_000,
})

// Better Auth returns `{ data, error }`; mutations need a thrown error.
export async function unwrap<T>(result: Promise<{ data: T; error: { message?: string } | null }>) {
  const { data, error } = await result
  if (error) throw new Error(error.message ?? 'Something went wrong')
  return data
}

/** Suggests a username from an email's local part, e.g. jane.doe+news@gmail.com → jane.doe */
export function suggestUsername(email: string) {
  return email
    .split('@')[0]
    .split('+')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 30)
}

export const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/
