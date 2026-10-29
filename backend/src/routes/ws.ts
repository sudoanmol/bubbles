import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { userDO, type AppEnv } from '../env'

/** One socket per device, held by the user's UserDO. */
export const ws = new Hono<AppEnv>().get('/', (c) => {
  if (c.req.header('upgrade') !== 'websocket') throw new HTTPException(426, { message: 'Expected a WebSocket' })

  return userDO(c.env, c.var.uid).fetch(c.req.raw)
})
