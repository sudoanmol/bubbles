// Profiles from D1: a group has more members than one D1 statement can take as parameters.
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import { profiles } from '../src/db/profiles'
import { MAX_MEMBERS } from '../src/protocol'

it('looks up every member of a full group', async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const ids = Array.from({ length: MAX_MEMBERS }, (_, i) => `u${i}`)
  const insert = env.DB.prepare('INSERT INTO user (id, name, email, username) VALUES (?1, ?1, ?1, ?1)')
  await env.DB.batch(ids.map((id) => insert.bind(id)))

  const found = await profiles(env.DB, ids)
  expect(found.size).toBe(MAX_MEMBERS)
  expect(found.get(ids.at(-1)!)).toEqual({ id: ids.at(-1), name: ids.at(-1), username: ids.at(-1), image: null })
})
