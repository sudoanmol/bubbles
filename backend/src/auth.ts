import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'
import { username } from 'better-auth/plugins'
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from './db/schema'

export const authOptions = {
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: 'sqlite', schema }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  },
  plugins: [username()],
  databaseHooks: {
    user: {
      // Everyone starts with the face drawn from their id, not their Google photo (Paper: "Default avatars").
      create: { before: async (user) => ({ data: { ...user, image: null } }) },
      // A profile photo is one uploaded here (routes/media.ts), never a link elsewhere that would track viewers.
      update: {
        before: async (user) => {
          if (user.image && !/^\/api\/media\/[\w-]+\/[0-9A-Z]{26}$/.test(user.image))
            throw new APIError('BAD_REQUEST', { message: 'Upload the photo first' })
        },
      },
    },
  },
  // Signed cookie carries the session for 5 min, so most requests skip D1.
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  // Limited in front of the handler by a LimitDO (index.ts); Better Auth's own limiter keeps counts in memory, per
  // isolate, which Workers can't share.
  rateLimit: { enabled: false },
  advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
} satisfies BetterAuthOptions

export const auth = betterAuth(authOptions)
