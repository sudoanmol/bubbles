import { env } from 'cloudflare:workers'

// One public origin. Static assets (the app) are served before this Worker runs; it only sees /api/*
// (`run_worker_first`), which it hands to the private backend Worker over the service binding.
export default {
  fetch: (request: Request) => env.API.fetch(request),
} satisfies ExportedHandler
