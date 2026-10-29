// Rate limits: production always asks the limiter; only a localhost auth URL skips it (for the chaos test).
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import { allowed } from '../src/env'

const limiter = (success: boolean) => {
  const calls: string[] = []

  return { calls, limit: async ({ key }: { key: string }) => (calls.push(key), { success }) }
}

it('limits in production and skips on localhost', async () => {
  const over = limiter(false)
  const prod = { ...env, BETTER_AUTH_URL: 'https://bubbles.sudoanmol.workers.dev' }
  expect(await allowed(prod, over, 'u1')).toBe(false)
  expect(over.calls).toEqual(['u1'])

  const local = limiter(false)
  expect(await allowed({ ...env, BETTER_AUTH_URL: 'http://localhost:3100' }, local, 'u1')).toBe(true)
  expect(local.calls).toEqual([])
})
