// Durable Object migrations: each runs once, even when older code (a rollback, or mid-deploy) starts in between.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import { migrate } from '../src/durable-objects/schema'

const v1 = ['CREATE TABLE t (a INTEGER)']
const v2 = [...v1, 'ALTER TABLE t ADD COLUMN b INTEGER']

it('runs each migration once, across a rollback and back', async () => {
  await runInDurableObject(env.USER.get(env.USER.idFromName('migrate')), (_instance, state) => {
    // Borrows a UserDO's storage; start its count over so these test migrations are the only ones.
    state.storage.sql.exec('DELETE FROM meta')
    for (const migrations of [v2, v1, v2]) migrate(state.storage, migrations)
    expect(state.storage.sql.exec('SELECT * FROM pragma_table_info(?)', 't').toArray()).toHaveLength(2)
  })
})
