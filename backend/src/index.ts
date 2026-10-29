import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { auth } from './auth'
import type { AppEnv } from './env'
import { isLocal } from './limits'
import { chats } from './routes/chats'
import { dev } from './routes/dev'
import { dms } from './routes/dms'
import { inbox } from './routes/inbox'
import { media } from './routes/media'
import { users } from './routes/users'
import { ws } from './routes/ws'

export { ChatDO } from './durable-objects/chat'

export { UserDO } from './durable-objects/user'

export { LimitDO } from './limits'

const app = new Hono<AppEnv>().basePath('/api')

// Password guessing and sign-up spam. No user yet, so this is keyed by IP, which a shared network can trip.
app.on('POST', ['/auth/sign-in/*', '/auth/sign-up/*'], async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') ?? ''

  if (!isLocal(c.env) && !(await c.env.LIMIT.get(c.env.LIMIT.idFromName(ip)).signIn()))
    throw new HTTPException(429, { message: 'Too many attempts. Try again in a minute.' })
  await next()
})

app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))

app.route('/dev', dev)

// Every route below needs a signed-in user who has picked a username.
app.use(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!session?.user.username) throw new HTTPException(401, { message: 'Sign in first' })
  c.set('uid', session.user.id)
  await next()
})

app.route('/ws', ws)

app.route('/inbox', inbox)

app.route('/dms', dms)

app.route('/chats', chats)

app.route('/users', users)

app.route('/media', media)

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ message: err.message }, err.status)
  console.error(err)

  return c.json({ message: 'Something went wrong' }, 500)
})

export default app
