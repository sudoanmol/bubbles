/// <reference types="bun" />
import { join, normalize } from 'node:path'
// @ts-expect-error -- built artifact, ships without type declarations
import handler from './dist/server/server.js'

const clientDir = join(import.meta.dir, 'dist', 'client')
const port = Number(process.env.PORT || 3000)

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' || req.method === 'HEAD') {
      const path = normalize(join(clientDir, url.pathname))
      if (path.startsWith(clientDir) && url.pathname !== '/') {
        const file = Bun.file(path)
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              'Cache-Control': url.pathname.startsWith('/assets/')
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=3600',
            },
          })
        }
      }
    }

    return handler.fetch(req)
  },
})

console.log(`Frontend server listening on :${port}`)
