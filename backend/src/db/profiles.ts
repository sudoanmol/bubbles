import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import type { Profile } from '../protocol'
import { user } from './schema'

/** Public profiles by user id, from D1. */
export async function profiles(db: D1Database, ids: string[]): Promise<Map<string, Profile>> {
  const rows = await drizzle(db)
    .select({ id: user.id, name: user.name, username: user.username, image: user.image })
    .from(user)
    .where(inArray(user.id, ids))
  return new Map(rows.map((r) => [r.id, { ...r, username: r.username! }]))
}
