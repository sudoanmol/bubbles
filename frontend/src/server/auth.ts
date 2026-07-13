import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import type { AuthResponse, ErrorResponse, SignInData, SignUpData, VerifyResponse } from '../types/auth'
import { useAppSession } from './session'
import { BACKEND_URL, getValidToken } from './utils'

export const signUpFn = createServerFn({ method: 'POST' })
  .inputValidator((data: SignUpData) => data)
  .handler(async ({ data }) => {
    try {
      const response = await fetch(`${BACKEND_URL}/auth/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error: ErrorResponse = await response.json()
        return { success: false, error: error.error, retry_after: error.retry_after }
      }

      const authResponse: AuthResponse = await response.json()

      // Store tokens and user in session
      const session = await useAppSession()
      await session.update({
        token: authResponse.token,
        refreshToken: authResponse.refresh_token,
        user: authResponse.user,
      })

      return { success: true, data: authResponse }
    } catch (error) {
      return {
        success: false,
        error: 'Failed to connect to server',
      }
    }
  })

export const signInFn = createServerFn({ method: 'POST' })
  .inputValidator((data: SignInData) => data)
  .handler(async ({ data }) => {
    try {
      const response = await fetch(`${BACKEND_URL}/auth/signin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error: ErrorResponse = await response.json()
        return { success: false, error: error.error, retry_after: error.retry_after }
      }

      const authResponse: AuthResponse = await response.json()

      // Store tokens and user in session
      const session = await useAppSession()
      await session.update({
        token: authResponse.token,
        refreshToken: authResponse.refresh_token,
        user: authResponse.user,
      })

      return { success: true, data: authResponse }
    } catch (error) {
      return {
        success: false,
        error: 'Failed to connect to server',
      }
    }
  })

// Verify Token and Get Current User
export const getCurrentUserFn = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await useAppSession()
  const token = await getValidToken(session)

  if (!token) {
    return null
  }

  try {
    const response = await fetch(`${BACKEND_URL}/auth/verify`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const verifyResponse: VerifyResponse = await response.json()

    if (!verifyResponse.success || !verifyResponse.user) {
      // Token is invalid, clear session
      await session.clear()
      return null
    }

    return verifyResponse.user
  } catch (error) {
    // Network error reaching the backend: keep the session so a transient
    // outage doesn't log the user out permanently.
    return null
  }
})

export const logoutFn = createServerFn({ method: 'POST' }).handler(async () => {
  const session = await useAppSession()

  const refreshToken = session.data.refreshToken
  if (refreshToken) {
    try {
      await fetch(`${BACKEND_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
    } catch {
      // Session is cleared regardless; the token expires server-side.
    }
  }

  await session.clear()
  throw redirect({ to: '/auth' })
})
