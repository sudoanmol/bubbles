// Rate limits: a window refuses past its limit and starts over after its period, and only a localhost auth URL skips
// them (for the chaos test).
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import { isLocal, Window } from '../src/limits'

it('refuses past the limit until the period is over', () => {
  const w = new Window({ limit: 2, period: 1000 })
  expect([w.hit(0), w.hit(10), w.hit(20), w.hit(999)]).toEqual([true, true, false, false])
  expect(w.hit(1000)).toBe(true)
})

it('limits in production and skips on localhost', () => {
  expect(isLocal({ ...env, BETTER_AUTH_URL: 'https://bubbles.sudoanmol.workers.dev' })).toBe(false)
  expect(isLocal({ ...env, BETTER_AUTH_URL: 'http://localhost:3100' })).toBe(true)
})
