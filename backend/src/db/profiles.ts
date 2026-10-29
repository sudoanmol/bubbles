import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import type { Profile } from '../protocol'
import { user } from './schema'

/** D1 refuses a statement with more than 100 bound parameters, and a group can have up to 256 members. */
const PER_QUERY = 100

/** Public profiles by user id, from D1. */
export async function profiles(db: D1Database, ids: string[]): Promise<Map<string, Profile>> {
  const chunks: string[][] = []

  for (let i = 0; i < ids.length; i += PER_QUERY) chunks.push(ids.slice(i, i + PER_QUERY))

  const rows = await Promise.all(
    chunks.map((chunk) =>
      drizzle(db)
        .select({ id: user.id, name: user.name, username: user.username, image: user.image })
        .from(user)
        .where(inArray(user.id, chunk))
    )
  )

  return new Map(rows.flat().map((r) => [r.id, { ...r, username: r.username! }]))
}
