// Chaos test for the delivery protocol (AGENTS.md, phase 2).
//
// Scripted clients DM each other as fast as they can while their sockets are killed at random and, partway through,
// the backend is redeployed (locally: a source file is touched, so `wrangler dev` restarts every Durable Object).
// Clients behave like the app: an outbox replayed on every connect, a cursor per chat, gap repair over HTTP.
// When the dust settles, every message written must be stored exactly once, each device's messages in the order
// it wrote them, and every client's copy of every chat must equal the server's.
//
//   pnpm chaos                 against the dev server (pnpm dev must be running)
//                              The redeploy edits backend/src/index.ts and reverts it seconds later (and on exit).
//   BASE=… REDEPLOY=0 pnpm chaos   another target, without the redeploy step

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { monotonicFactory } from 'ulid'

const BASE = process.env.BASE ?? 'http://localhost:3100'
const REDEPLOY = process.env.REDEPLOY !== '0'
const USERS = 6
const DEVICES_PER_USER = 2 // two sockets for one user, like a phone and a laptop
const MESSAGES_PER_DEVICE = 100
const SEND_EVERY_MS = 40
const KILL_EVERY_MS = 150

type Message = { chat: string; seq: number; cid: string; sender: string; body: string; ts: number }
type Frame =
  | { t: 'ack'; chat: string; cid: string; seq: number; ts: number }
  | { t: 'msg'; msg: Message }
  | { t: 'error'; cid?: string; message: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

async function http<T>(cookie: string, path: string, init: RequestInit = {}): Promise<T> {
  // The backend may be restarting; keep trying like a client would.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        ...init,
        headers: { 'content-type': 'application/json', origin: BASE, cookie, ...init.headers },
      })
      if (res.ok) return (await res.json()) as T
      if (res.status < 500 || attempt > 40) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    } catch (error) {
      if (attempt > 40) throw error
    }
    await sleep(250)
  }
}

async function signUp(username: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: `${username}@chaos.test`, password: 'chaos-password-1', name: username, username }),
  })
  if (!res.ok) throw new Error(`sign up ${username}: ${res.status} ${await res.text()}`)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const { user } = (await res.json()) as { user: { id: string } }
  return { username, id: user.id, cookie }
}

class Device {
  name: string
  cookie: string
  chats: string[]
  ulid = monotonicFactory()
  ws: WebSocket | null = null
  /** Written, not yet acked; replayed in write order on every connect. */
  outbox = new Map<string, { chat: string; cid: string; body: string }>()
  /** Every cid this device wrote, in write order. */
  written: { chat: string; cid: string }[] = []
  log = new Map<string, Map<number, Message>>()
  conflicts: string[] = []
  errors: string[] = []
  closed = false
  connects = 0
  /** Sockets the server dropped (the redeploy), as opposed to ones this test killed. */
  drops = 0
  killing = false

  constructor(name: string, cookie: string, chats: string[]) {
    this.name = name
    this.cookie = cookie
    this.chats = chats
    for (const c of chats) this.log.set(c, new Map())
  }

  connect() {
    if (this.closed) return
    // Node's WebSocket (undici) takes request headers, so the session cookie rides along like in a browser.
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/ws', { headers: { cookie: this.cookie } } as never)
    this.ws = ws
    ws.onopen = () => {
      this.connects++
      for (const m of this.outbox.values()) ws.send(JSON.stringify({ t: 'send', ...m }))
      // Like the app after a reconnect: catch up on what was missed while away.
      for (const c of this.chats) void this.repair(c)
    }
    ws.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as Frame)
    ws.onclose = () => {
      if (!this.killing && !this.closed) this.drops++
      this.killing = false
      if (this.ws === ws) this.ws = null
      setTimeout(() => this.connect(), 50 + Math.random() * 250)
    }
    ws.onerror = () => {}
  }

  kill() {
    if (!this.ws) return
    this.killing = true
    this.ws.close()
  }

  send(chat: string, body: string) {
    const m = { chat, cid: this.ulid(), body }
    this.outbox.set(m.cid, m)
    this.written.push({ chat, cid: m.cid })
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'send', ...m }))
  }

  receive(f: Frame) {
    if (f.t === 'ack') this.outbox.delete(f.cid)
    if (f.t === 'msg') this.store(f.msg)
    // The message stays in the outbox and goes again on the next connect.
    if (f.t === 'error') this.errors.push(f.message)
  }

  store(m: Message) {
    const log = this.log.get(m.chat)!
    const prev = log.get(m.seq)
    if (prev && prev.cid !== m.cid) this.conflicts.push(`${m.chat} seq ${m.seq}: ${prev.cid} then ${m.cid}`)
    log.set(m.seq, m)
  }

  cursor(chat: string) {
    const log = this.log.get(chat)!
    let hi = 0
    while (log.has(hi + 1)) hi++
    return hi
  }

  /** Fills everything after the cursor. If the server jumps to its latest page, page back down to the cursor. */
  async repair(chat: string) {
    for (;;) {
      const hi = this.cursor(chat)
      const page = await http<Message[]>(this.cookie, `/api/chats/${chat}/messages?after=${hi}`)
      if (!page.length) return
      page.forEach((m) => this.store(m))
      let before = page[0].seq
      while (before > hi + 1) {
        const older = await http<Message[]>(this.cookie, `/api/chats/${chat}/messages?before=${before}`)
        older.forEach((m) => this.store(m))
        before = older[0]?.seq ?? hi + 1
      }
    }
  }
}

// wrangler dev rebuilds when a source file's content changes and restarts every Durable Object, dropping every
// socket: a local deploy. Reverting the edit a few seconds later restarts it once more.
const entry = new URL('../backend/src/index.ts', import.meta.url)
const original = readFileSync(entry, 'utf8')
const revert = () => writeFileSync(entry, original)
process.on('exit', revert)

// The test's accounts (all on @chaos.test) leave the local database when it ends, pass or fail. Their sessions and
// accounts go with them (ON DELETE CASCADE). ponytail: their chats' Durable Object storage stays in .wrangler/state.
const local = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)
process.on('exit', () => {
  if (!local) return
  try {
    execFileSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--local',
        '--command',
        "DELETE FROM user WHERE email GLOB '*@chaos.test'",
      ],
      { cwd: new URL('../backend', import.meta.url), stdio: 'ignore' }
    )
    console.log('removed the chaos users from the local database')
  } catch {
    console.error("could not remove the chaos users; run: DELETE FROM user WHERE email GLOB '*@chaos.test'")
  }
})
process.on('SIGINT', () => process.exit(130))

function redeploy() {
  console.log('redeploying the backend mid-stream (twice: edit, then revert)…')
  writeFileSync(entry, original + `\n// chaos redeploy ${Date.now()}\n`)
  setTimeout(revert, 3000)
}

async function main() {
  const run = Date.now().toString(36)
  console.log(`chaos ${run}: ${USERS} users × ${DEVICES_PER_USER} devices × ${MESSAGES_PER_DEVICE} messages → ${BASE}`)

  const users = await Promise.all(Array.from({ length: USERS }, (_, i) => signUp(`chaos_${run}_${i}`)))
  // A ring of DMs, so every user is in two chats.
  const chatsOf = new Map<string, string[]>(users.map((u) => [u.id, []]))
  for (let i = 0; i < USERS; i++) {
    const [a, b] = [users[i], users[(i + 1) % USERS]]
    const { chatId } = await http<{ chatId: string }>(a.cookie, `/api/dms/${b.username}`, { method: 'POST' })
    chatsOf.get(a.id)!.push(chatId)
    chatsOf.get(b.id)!.push(chatId)
  }
  const devices = users.flatMap((u) =>
    Array.from({ length: DEVICES_PER_USER }, (_, d) => new Device(`${u.username}#${d}`, u.cookie, chatsOf.get(u.id)!))
  )
  devices.forEach((d) => d.connect())
  await sleep(1000)

  // Chaos: kill a random socket every KILL_EVERY_MS while everyone sends.
  let kills = 0
  const chaos = setInterval(() => {
    pick(devices).kill()
    kills++
  }, KILL_EVERY_MS)
  const total = MESSAGES_PER_DEVICE * devices.length
  let redeployed = false
  await Promise.all(
    devices.map(async (d) => {
      for (let i = 0; i < MESSAGES_PER_DEVICE; i++) {
        d.send(pick(d.chats), `${d.name} ${i}`)
        if (REDEPLOY && !redeployed && d === devices[0] && i === MESSAGES_PER_DEVICE / 2) {
          redeployed = true
          redeploy()
        }
        await sleep(SEND_EVERY_MS * (0.5 + Math.random()))
      }
    })
  )
  clearInterval(chaos)

  // Let every outbox drain, then a final catch-up, as when an app comes back to the foreground.
  const deadline = Date.now() + 60_000
  while (devices.some((d) => d.outbox.size) && Date.now() < deadline) await sleep(250)
  await Promise.all(devices.flatMap((d) => d.chats.map((c) => d.repair(c))))
  devices.forEach((d) => {
    d.closed = true
    d.ws?.close()
  })

  // The server's copy of each chat, read in full.
  const server = new Map<string, Message[]>()
  for (const chat of new Set([...chatsOf.values()].flat())) {
    const owner = users.find((u) => chatsOf.get(u.id)!.includes(chat))!
    const all: Message[] = []
    let page = await http<Message[]>(owner.cookie, `/api/chats/${chat}/messages`)
    while (page.length) {
      all.unshift(...page)
      if (page[0].seq === 1) break
      page = await http<Message[]>(owner.cookie, `/api/chats/${chat}/messages?before=${page[0].seq}`)
    }
    server.set(chat, all)
  }

  const failures: string[] = []
  const stored = new Map<string, Message>()
  for (const [chat, messages] of server) {
    messages.forEach((m, i) => {
      if (m.seq !== i + 1) failures.push(`${chat}: seq ${m.seq} at position ${i + 1} (gap or reorder)`)
      if (stored.has(m.cid)) failures.push(`${chat}: cid ${m.cid} stored twice`)
      stored.set(m.cid, m)
    })
  }
  for (const d of devices) {
    failures.push(...d.conflicts.map((c) => `${d.name}: ${c}`))
    if (d.outbox.size) failures.push(`${d.name}: ${d.outbox.size} messages never acked`)
    // Exactly once, and in the order this device wrote them.
    const lastSeq = new Map<string, number>()
    for (const { chat, cid } of d.written) {
      const m = stored.get(cid)
      if (!m) {
        failures.push(`${d.name}: ${cid} lost`)
        continue
      }
      if ((lastSeq.get(chat) ?? 0) >= m.seq) failures.push(`${d.name}: ${cid} stored out of write order`)
      lastSeq.set(chat, m.seq)
    }
    // This device's copy of each chat equals the server's.
    for (const chat of d.chats) {
      const mine = [...d.log.get(chat)!.values()].sort((a, b) => a.seq - b.seq)
      const theirs = server.get(chat)!
      const same =
        mine.length === theirs.length &&
        mine.every((m, i) => m.seq === theirs[i].seq && m.cid === theirs[i].cid && m.body === theirs[i].body)
      if (!same) failures.push(`${d.name}: copy of ${chat} differs (${mine.length} vs ${theirs.length} messages)`)
    }
  }

  const connects = devices.reduce((n, d) => n + d.connects, 0)
  const errors = devices.flatMap((d) => d.errors)
  const drops = devices.reduce((n, d) => n + d.drops, 0)
  console.log(
    `${stored.size}/${total} messages stored, ${kills} sockets killed, ${drops} dropped by the server, ${connects} connects` +
      (redeployed ? ', 2 redeploys' : '') +
      (errors.length ? `, ${errors.length} send errors (${[...new Set(errors)].join('; ')})` : '')
  )
  if (failures.length) {
    console.error(`FAIL: ${failures.length} problems\n` + failures.slice(0, 30).join('\n'))
    process.exit(1)
  }
  console.log('PASS: every message stored exactly once, in order, and every client matches the server')
  process.exit(0)
}

await main()
