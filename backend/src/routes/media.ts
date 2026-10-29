import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { AppEnv } from '../env'
import { MAX_IMAGE_BYTES } from '../protocol'

const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const Id = /^[0-9A-Z]{26}$/

/**
 * Photos, in R2 under `<uploader id>/<ulid>`. The client picks the ulid, so a retried upload lands on the same key.
 * A key is written once: it's served as immutable, and a photo must not change after it's sent.
 * Uploads go through this Worker rather than to presigned R2 URLs: no S3 keys or bucket CORS, and the same path
 * works in local dev. Keys are unguessable and only signed-in users can read them.
 * ponytail: anyone signed in who has a key can see the photo; check chat membership if keys ever leak.
 */
export const media = new Hono<AppEnv>()
  .put('/:id', async (c) => {
    const id = c.req.param('id')
    const type = c.req.header('content-type') ?? ''
    const size = Number(c.req.header('content-length'))

    if (!Id.test(id) || !TYPES.has(type))
      throw new HTTPException(400, { message: 'Photos only: JPEG, PNG, GIF or WebP' })

    if (!(size <= MAX_IMAGE_BYTES)) throw new HTTPException(413, { message: 'Photos can be up to 10 MB' })
    const key = `${c.var.uid}/${id}`

    if (await c.env.MEDIA.head(key)) return c.body(null, 204)
    const body = await c.req.arrayBuffer()

    if (body.byteLength > MAX_IMAGE_BYTES) throw new HTTPException(413, { message: 'Photos can be up to 10 MB' })
    await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: type } })

    return c.body(null, 204)
  })
  .get('/:uid/:id', async (c) => {
    const id = c.req.param('id')
    const obj = Id.test(id) ? await c.env.MEDIA.get(`${c.req.param('uid')}/${id}`) : null

    if (!obj) throw new HTTPException(404, { message: 'Not found' })

    // A key's bytes never change, so the browser keeps it: scrolling back shows it from cache.
    return c.body(obj.body, 200, {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      etag: obj.httpEtag,
    })
  })
