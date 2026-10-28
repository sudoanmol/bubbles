import { Hono } from 'hono'

import { auth } from './auth'

const app = new Hono().basePath('/api')

app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))

export type AppType = typeof app
export default app
