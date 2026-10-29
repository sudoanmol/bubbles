// Photos are write-once: a retried upload of a key keeps what it first stored, so a sent photo can't be swapped for
// another (`pnpm -C backend test`).
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { expect, it } from 'vitest'

import type { AppEnv } from '../src/env'
import { media } from '../src/routes/media'

// The media routes as mounted, signed in as `a`.
const app = new Hono<AppEnv>()
  .use((c, next) => {
    c.set('uid', 'a')

    return next()
  })
  .route('/', media)

const id = '01JAX9ZZZZZZZZZZZZZZZZZZZ1'

const put = (bytes: string) =>
  app.request(
    `/${id}`,
    { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': `${bytes.length}` }, body: bytes },
    env
  )

it('keeps the first upload of a key', async () => {
  expect((await put('first')).status).toBe(204)
  expect((await put('second')).status).toBe(204)
  expect(await (await env.MEDIA.get(`a/${id}`))?.text()).toBe('first')
})
