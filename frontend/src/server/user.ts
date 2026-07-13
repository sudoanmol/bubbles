import type { User } from '@/types/auth'
import { createServerFn } from '@tanstack/react-start'
import { useAppSession } from './session'
import { authenticatedFetch } from './utils'

export type UpdateUserProfileInput = {
  username: string
  profile_image_url?: string | null
}

export const updateUserProfileFn = createServerFn({ method: 'POST' })
  .validator((data: UpdateUserProfileInput) => data)
  .handler(async ({ data }) => {
    const session = await useAppSession()

    const result = await authenticatedFetch<{ user: User }>(
      '/user/profile',
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
      'Failed to connect to server',
      session
    )

    if (!result.success) {
      return { success: false, error: result.error }
    }

    if (!('data' in result) || !result.data) {
      return { success: false, error: 'Invalid server response' }
    }

    await session.update({
      token: session.data.token,
      user: result.data.user,
    })

    return { success: true, user: result.data.user }
  })
