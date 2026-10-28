import { and, isNotNull, ne, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { user } from '../db/schema'
import type { AppEnv } from '../env'
import type { Profile } from '../protocol'

// Same characters usernames allow, so the query is safe inside GLOB/LIKE patterns.
const Query = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^@?[a-z0-9_. ]{1,30}$/))

/** People to start a chat with: username prefix, or a word in their name that starts with the query. */
export const users = new Hono<AppEnv>().get('/', async (c) => {
  const parsed = v.safeParse(Query, c.req.query('q') ?? '')
  if (!parsed.success) return c.json([] as Profile[])
  const q = parsed.output.replace(/^@/, '')
  // ponytail: the name match scans the user table; move to an FTS5 index when it holds many users.
  const rows = await drizzle(c.env.DB)
    .select({ id: user.id, name: user.name, username: user.username, image: user.image })
    .from(user)
    .where(
      and(
        ne(user.id, c.var.uid),
        // Users who signed up with Google but have not picked a username yet cannot be messaged.
        isNotNull(user.username),
        or(
          sql`${user.username} GLOB ${`${q}*`}`,
          sql`lower(${user.name}) LIKE ${`${q}%`}`,
          sql`lower(${user.name}) LIKE ${`% ${q}%`}`
        )
      )
    )
    .orderBy(user.username)
    .limit(8)
  return c.json(rows.map((r): Profile => ({ ...r, username: r.username! })))
})
