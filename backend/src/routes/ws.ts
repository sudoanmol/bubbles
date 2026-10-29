import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { allowed, userDO, type AppEnv } from '../env'

/** One socket per device, held by the user's UserDO. */
export const ws = new Hono<AppEnv>().get('/', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') throw new HTTPException(426, { message: 'Expected a WebSocket' })

  // The client backs off and tries again.
  if (!(await allowed(c.env, c.env.CONNECT_LIMIT, c.var.uid)))
    throw new HTTPException(429, { message: 'Too many connections' })

  return userDO(c.env, c.var.uid).fetch(c.req.raw)
})
