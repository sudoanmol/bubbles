import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'

const start = createStartHandler(defaultStreamHandler)

// One public origin: /api/* goes to the private backend worker over a service binding.
export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname.startsWith('/api/')) return env.API.fetch(request)
    return start(request)
  },
}
