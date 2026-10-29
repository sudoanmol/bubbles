import { DurableObject } from 'cloudflare:workers'

// Rate limits, counted in Durable Objects: each key's hits go through one object, one at a time, so a count is exact
// and global. (The Workers Rate Limiting binding never refuses once deployed: cloudflare/workers-sdk#16097.)
/** Socket frames per user (messages, changes, typing, reads), counted in their UserDO. */
export const FRAMES = { limit: 60, period: 10_000 }

/** Socket connects per user; reconnect loops and many tabs stay well under it. */
export const CONNECTS = { limit: 20, period: 60_000 }

/** Sign-in and sign-up attempts per IP, counted in a LimitDO. */
const SIGN_INS = { limit: 10, period: 60_000 }

/**
 * At most `limit` hits per `period` ms. Held in memory, so it starts over if its object is evicted, which only happens
 * once the object has been idle.
 * ponytail: a fixed window lets up to twice the limit through around a window edge; a sliding window if that matters.
 */
export class Window {
  start = 0
  count = 0

  constructor(readonly rule: { limit: number; period: number }) {}

  hit(now = Date.now()) {
    if (now - this.start >= this.rule.period) {
      this.start = now
      this.count = 0
    }

    return ++this.count <= this.rule.limit
  }
}

/** Local runs skip limits (the chaos test floods the socket on purpose); production cannot, as the URL is its own. */
export const isLocal = (env: CloudflareBindings) => new URL(env.BETTER_AUTH_URL).hostname === 'localhost'

/** One per IP: counts its sign-in and sign-up attempts. */
export class LimitDO extends DurableObject<CloudflareBindings> {
  signIns = new Window(SIGN_INS)

  signIn() {
    return this.signIns.hit()
  }
}
