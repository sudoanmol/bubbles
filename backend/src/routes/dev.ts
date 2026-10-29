import { betterAuth } from 'better-auth'
import { testUtils } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'

import { authOptions } from '../auth'
import { user } from '../db/schema'
import type { AppEnv } from '../env'

// A separate auth instance carries the test helpers, as Better Auth recommends, so the real one never has them.
const testAuth = betterAuth({ ...authOptions, plugins: [...authOptions.plugins, testUtils()] })

/**
 * Local-only sign-in as any user, for testing two accounts side by side:
 * open http://localhost:3100/api/dev/login/<username> in a private window.
 */
export const dev = new Hono<AppEnv>().get('/login/:username', async (c) => {
  // Keyed off BETTER_AUTH_URL rather than a flag, so it cannot be switched on in production by mistake.
  if (new URL(c.env.BETTER_AUTH_URL).hostname !== 'localhost') throw new HTTPException(404, { message: 'Not found' })

  const [found] = await drizzle(c.env.DB)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, c.req.param('username').toLowerCase()))

  if (!found) throw new HTTPException(404, { message: 'No one has that username' })

  const { test } = await testAuth.$context

  for (const cookie of await test.getCookies({ userId: found.id })) {
    setCookie(c, cookie.name, cookie.value, {
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      expires: cookie.expires ? new Date(cookie.expires * 1000) : undefined,
    })
  }

  return c.redirect('/')
})
