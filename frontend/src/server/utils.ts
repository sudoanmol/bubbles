import { redirect } from '@tanstack/react-router'
import type { AuthResponse, ErrorResponse } from '../types/auth'
import { useAppSession } from './session'

export const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:8000'

const TOKEN_REFRESH_SKEW_MS = 60_000

function tokenNeedsRefresh(token: string) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp !== 'number') return false
    return payload.exp * 1000 <= Date.now() + TOKEN_REFRESH_SKEW_MS
  } catch {
    return false
  }
}

// getValidToken returns the session's JWT, transparently exchanging the
// refresh token for a new one when the JWT is expired or about to expire.
// Returns null when the session is unauthenticated or the refresh token was
// rejected (in which case the session is cleared).
export async function getValidToken(session: Awaited<ReturnType<typeof useAppSession>>): Promise<string | null> {
  const { token, refreshToken } = session.data

  if (!token) return null
  if (!tokenNeedsRefresh(token)) return token
  if (!refreshToken) return token

  try {
    const response = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (response.status === 401) {
      await session.clear()
      return null
    }

    if (!response.ok) {
      // Transient server error: let the caller try its luck with the
      // current token rather than logging the user out.
      return token
    }

    const auth: AuthResponse = await response.json()
    await session.update({
      token: auth.token,
      refreshToken: auth.refresh_token,
      user: auth.user,
    })
    return auth.token
  } catch {
    return token
  }
}

export type AuthenticatedFetchResult<T> =
  | { success: true; data?: T }
  | { success: false; error: string; retry_after?: number }

export const authenticatedFetch = async <T = Record<string, never>>(
  path: string,
  options: RequestInit = {},
  errorFallback: string,
  sessionOverride?: Awaited<ReturnType<typeof useAppSession>>
): Promise<AuthenticatedFetchResult<T>> => {
  const session = sessionOverride ?? (await useAppSession())
  const token = await getValidToken(session)

  if (!token) {
    throw redirect({ to: '/auth' })
  }

  try {
    const { headers, method, ...restOptions } = options

    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: method ?? 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
      ...restOptions,
    })

    if (!response.ok) {
      const error: ErrorResponse = await response.json()
      return { success: false, error: error.error, retry_after: error.retry_after }
    }

    if (response.headers.get('content-length') === '0' || response.status === 204) {
      return { success: true }
    }

    const data = (await response.json()) as T
    return { success: true, data }
  } catch {
    return {
      success: false,
      error: errorFallback,
    }
  }
}
