# Bubbles

A real-time chat app built entirely on Cloudflare. The goal is a very light, very fast chat app that just works, and proves it with published numbers rather than a long feature list: one actor per chat, one actor per user, one WebSocket per device, a local-first client, a small bundle. Every feature must earn its bytes; prefer what the browser already ships (WebRTC, MediaRecorder, IndexedDB) over libraries.

Build it in layers. Every phase below ends with something that works end to end and can be deployed. Do not start a phase until the previous one works in production.

## Repository

pnpm workspace (never npm or bun):

```
backend/    Worker `bubbles-api` (private): Hono, auth, API, Durable Objects
  src/index.ts            app wiring: auth mount, session middleware, route mounts, DO exports
  src/routes/             one Hono router per resource (ws, inbox, dms, chats, users)
  src/durable-objects/    UserDO (user.ts), ChatDO (chat.ts)
  src/protocol.ts         wire protocol shared with the frontend (`import … from 'backend/protocol'`)
frontend/   Worker `bubbles` (public): single-page app on TanStack Router, React 19, Tailwind v4, TanStack Query, shadcn (Base UI)
  src/main.tsx            client entry (router + query client)
  src/worker.ts           the Worker: static assets first, then /api/* → `API` service binding
  src/routes/_app*        signed-in shell (inbox + open chat); `/`, `/c/$chatId`, `/@{$username}`
  src/hooks/              shared React hooks
  src/lib/                api + sync (api.ts), pure log rules (log.ts), IndexedDB store (store.ts), socket + outbox (socket.ts), session, auth, time
  src/components/ui/      shadcn components; we own and restyle them
tests/chaos.ts  chaos test for the delivery protocol (`pnpm chaos`)
tests/rules.ts  the pure log and inbox rules under every arrival order
tests/store.ts  the IndexedDB store (fake-indexeddb): rev guard, outbox across reloads, sign-out with two tabs open
backend/test/   Durable Objects in the Workers runtime (@cloudflare/vitest-plugin): fan-out after failure and eviction
.env        the only env file, shared by every package (copy from .env.example)
```

| Task                 | Command (from the root)                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Install              | `pnpm install`                                                                                                               |
| Chaos test           | `pnpm chaos` with `pnpm dev` running (edits and reverts `backend/src/index.ts` to redeploy mid-run; `REDEPLOY=0` skips that) |
| Sign in as any user  | Open `http://localhost:3100/api/dev/login/<username>` (local only; for testing two accounts side by side)                    |
| Dev (both workers)   | `pnpm dev` (app on :3100, API on :8790; the API restarts when `.env` changes)                                                |
| Test                 | `pnpm test`                                                                                                                  |
| Typecheck            | `pnpm typecheck`                                                                                                             |
| Build                | `pnpm build`                                                                                                                 |
| Lint / format        | `pnpm lint`, `pnpm fmt` (oxlint + oxfmt; also run on pre-commit via husky + lint-staged)                                     |
| Worker binding types | `pnpm -C <pkg> cf-typegen` after editing that package's `wrangler.jsonc`                                                     |

Assume the dev server is already running. Verify work with `pnpm typecheck` and `pnpm build`.

### Conventions

- Add dependencies with `pnpm -C <pkg> add`. Never edit manifests by hand to add one.
- Secrets and config live in the root `.env`. The backend loads it with `wrangler dev --env-file ../.env`, wrapped in `node --watch-path` because wrangler does not watch env files. In production, use `wrangler secret put`. Add every new key to `.env.example`.
- Database access goes through Drizzle ORM. The Better Auth tables are generated, so never hand-edit them (see Auth).
- Parse all external input at the boundary: HTTP bodies, WebSocket frames, env.
- Do not keep backward compatibility. This is a rewrite, so delete obsolete paths.
- When a change adds or fixes a rule that could quietly break later (ordering, idempotency, revisions, retries, account and tab lifecycle), add a check to the matching test file: `tests/rules.ts` for pure rules, `tests/store.ts` for the device store, `backend/test/` for Durable Objects. Make sure it fails without the change. Test only what could regress unnoticed; skip the obvious (plain wiring, UI markup, what the type checker already catches).
- Prefer platform primitives (Durable Objects, D1, R2, Queues, Rate Limiting binding) over adding services.

## Architecture

```
Browser (IndexedDB cache, outbox, seq cursors, 1 WebSocket)
   │ one public origin: bubbles.sudoanmol.workers.dev
   ▼
bubbles (frontend Worker) ── static SPA assets; /api/* → service binding `API`
   ▼
bubbles-api (backend Worker, no public URL) ── auth (Better Auth + D1), routing
   │ WebSocket (hibernating)
   ▼
UserDO (1 per user)  ── holds the user's sockets, inbox, unread counts, push subscriptions
   │ RPC send ▲ RPC fan-out
   ▼          │
ChatDO (1 per chat)  ── SQLite: members, messages, seq, reactions, FTS5
Other stores: D1 (users/auth only) · R2 (media) · Queues (web push) · Analytics Engine (latency)
```

- **One socket per device, held by UserDO.** Clients never open a socket per chat. ChatDO fans each message out to its members' UserDOs over RPC, and each UserDO pushes it to that user's sockets. The inbox (chat list, unread counts, previews) is then one local SQLite read inside the UserDO.
- **ChatDO is the single source of truth for a chat.** A Durable Object handles one request at a time, so every chat gets a strict total order for free: a monotonic `seq` per chat, with no locks and no Redis.
- **WebSocket Hibernation API** (`ctx.acceptWebSocket`). Idle sockets cost nothing.
- **D1 holds only global data:** users, sessions, accounts, handles, user search. Chat data never goes into D1. It lives in each ChatDO's own durable SQLite database, which has 30-day point-in-time recovery. Cross-chat queries (global search, deleting a user's data) fan out over the user's inbox. Analytics comes from copying events to Analytics Engine or Queues, never from querying live chat databases.
- **One origin, private API.** `frontend/src/worker.ts` forwards `/api/*` to `bubbles-api` over the `API` service binding (no network hop). The API Worker has `workers_dev: false`, so it has no public URL. Cookie auth needs no CORS and no custom domain. The same path runs in dev: the Vite plugin reaches the local `wrangler dev` through the dev registry.
- **A plain single-page app, no SSR.** Static assets are served before the Worker runs (`run_worker_first: ["/api/*"]`, `not_found_handling: "single-page-application"`), so the Worker only ever sees API calls. The app renders on the client from the local cache. We dropped TanStack Start: with no SSR and no server functions it only added ~10 KB of serializer.

### Stack

| Layer                  | Choice                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Frontend               | TanStack Router (file routes, auto code splitting) as an SPA, React 19 + React Compiler (Babel), Tailwind v4 |
| Client data            | TanStack Query (the store the UI reads); `idb` writes it through to IndexedDB (phase 2)                      |
| UI kit                 | shadcn on Base UI (`Message`, `Bubble`, `MessageScroller`, `Dialog`), lucide icons                           |
| Socket client          | `partysocket` (reconnect with backoff)                                                                       |
| API                    | Hono, one router per resource in `backend/src/routes/`                                                       |
| Protocol               | Valibot schemas and response types in `backend/src/protocol.ts`; frames are parsed on both sides             |
| Auth                   | Better Auth on D1 via the Drizzle adapter: email/password, username plugin, Google OAuth                     |
| Storage                | DO SQLite (`new_sqlite_classes`, raw `ctx.storage.sql`), D1 + Drizzle, R2                                    |
| Async                  | Queues → Web Push (VAPID)                                                                                    |
| Limits / observability | Rate Limiting binding, Workers Logs, Analytics Engine                                                        |
| Tooling                | oxlint, oxfmt, husky + lint-staged                                                                           |

## Auth

- Better Auth is mounted at `/api/auth/*` in the backend. Its config is in `backend/src/auth.ts`.
- Sign-in methods: email or username plus a password (the login form takes either one), and Google OAuth.
- Every user must have a username. Users who sign in with Google have none at first, so the frontend route guard sends them to `/login/username`. That page pre-fills the username from the local part of their email (for `jane.doe@gmail.com`, it suggests `jane.doe`). The user can change it, availability is checked live, and the page then redirects to `/`.
- Usernames: 3–30 characters, letters, digits, `_` and `.`, stored lowercase (plugin defaults).
- The schema is generated, never hand-written: `pnpm -C backend auth:generate` writes the Drizzle schema, then `pnpm -C backend db:generate` writes the SQL migration, then `pnpm -C backend db:migrate` applies it to local D1 (`pnpm dev` also applies pending local migrations on start).
- The frontend reads the session through TanStack Query (`sessionQuery`). Route guards in `beforeLoad` call `ensureQueryData`. After any auth change, refetch the session before navigating.

### Routes

| Path              | Who can see it                     | Purpose                                                                |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `/login`          | Signed-out users                   | Sign in (email or username + password), sign up, Google                |
| `/login/username` | Signed-in users without a username | Choose a username                                                      |
| `/`               | Signed-in users with a username    | Home: inbox and chats                                                  |
| `/c/$chatId`      | Chat members                       | A chat (DM or group); the canonical chat URL                           |
| `/@$username`     | Signed-in users                    | Opens or creates the DM with that user, then redirects to `/c/$chatId` |

Chat URLs use the permanent chat id. Group names and usernames can change and group names are not unique, so they are never part of a canonical URL; `/@username` is only a redirect.

## Delivery protocol (the core of the project)

```
client                          UserDO                    ChatDO
  │ send {cid: ULID, chat, body}  │                          │
  │──────────────────────────────▶│ rpc send(uid, cid, body) │
  │                               │─────────────────────────▶│ INSERT … ON CONFLICT(cid) DO NOTHING
  │                               │                          │ seq = last_seq + 1   (single-threaded)
  │        ack {cid, seq, ts}     │◀─────────────────────────│
  │◀──────────────────────────────│                          │ for m in members: UserDO(m).deliver(msg)
  │   msg {chat, seq, …}          │◀──── deliver ────────────│
  │◀──────────────────────────────│ bump unread; push to sockets, or enqueue a web push
```

- **Idempotent sends.** The client generates `cid` (a ULID) and writes the message to its outbox (IndexedDB) before sending: one queue stores each frame, then sends it, so nothing goes out before it is stored or ahead of an older frame. `UNIQUE(cid)` in ChatDO makes retries harmless. The outbox is replayed, in write order, on every connect, so it survives going offline and reloads. UserDO handles a socket's frames one at a time so a replayed burst keeps its order.
- **Gap detection.** A chat's cursor is the end of the unbroken run of `seq`s the client holds. Syncing a chat is `GET /api/chats/:id/messages?after=<cursor>`; if the client is more than a page behind, the server returns the latest page instead and the client drops its older copy, so what it stores is always one unbroken run. A live message past a gap shows at once and triggers a sync of that chat if it's on screen. On reconnect the client refetches the inbox and syncs the chats on screen; other chats sync when opened.
- **Refused versus failed.** ChatDO returns a refusal (not a member, message gone, not yours); UserDO sends it as an `error` frame and the client stops retrying. Any other failure (ChatDO unreachable, outcome unknown) closes the socket, and the client reconnects and replays its outbox with the same `cid`s. UserDO skips later frames from a closing socket so they can't overtake the failed one.
- **Durable fan-out.** ChatDO keeps `delivery(user_id, seq)`, the last entry each member's UserDO stored, and fans out everything after it, in order, in batches. An alarm set with every write retries members that failed, or finishes a fan-out cut short by an eviction or a deploy. UserDO applies entries idempotently (`nextPreview` in `protocol.ts`, shared with the client).
- **Deploys are routine.** A deploy drops sockets. The client reconnects, replays its outbox and fills any gaps.
- **Edits, deletes and reactions** are log entries too (`kind: 'patch'`) with their own `seq`, so gap repair covers them. ChatDO updates the message in place and appends a patch carrying the message's new state; every copy keeps whichever state has the higher `rev` (the seq of its last change), so patches apply idempotently and in any order. Deletes are tombstones. `applyPatch` in `protocol.ts` is the one rule for what a change does: the server stores with it, the client shows its own unsent changes with it. A refused message stays as "Not sent"; a refused change is dropped and the message reverts.
- **Read receipts** are not log entries and don't use the outbox. While a chat is open in a visible tab, the client sends `read {chat, seq}` for its newest entry, and sends it again on every reconnect. ChatDO moves the member's `read_seq` forward (never back), returns the reader's unread count to their UserDO, which pushes it to all their devices, and sends a receipt to the other members. Sending a message counts as reading the chat. A missed receipt is caught up when the chat is next loaded (`GET /chats/:id` carries every member's read). Unread counts follow `nextRead` in `protocol.ts`, shared by UserDO and the client.
- **Ephemeral events** are never stored or retried. Typing travels the message path (UserDO → ChatDO → the other members' UserDOs): the client sends one event every 3 seconds for as long as you keep typing, and others show the dots until 5 seconds pass without one or your message arrives. Presence: every device pings its socket every 30 s, answered by the runtime without waking UserDO (and a missed pong makes the client reconnect). UserDO counts a device as online while it has pinged in the last 90 s, and stays online for a 10 s grace after the last one closes so a reload doesn't flicker. Opening a chat calls `GET /chats/:id/presence`, which also subscribes the asker to each member's changes for 2.5 minutes (`watcher` table); the open chat renews it every minute. UserDO pushes a `presence` frame to its watchers when it comes online, and when the grace period ends (an alarm). A device that dies without closing is caught by the next poll.
- **Known limits:** each DO lives in one location (near where it was created). A single DO handles roughly 1k req/s. Fan-out happens on every send, so groups are capped at about 256 members. Mark these limits with `ponytail:` comments in the code.

### Data model

- **Client (IndexedDB, one database per account, `bubbles-<uid>`):** `messages` (the log, keyed `[chat, seq]`, patches included), `outbox` (unacked frames, by `cid`), `inbox`, `chats`. The confirmed log (`['messages', chat]`) and the outbox (`['outbox']`) are separate queries; a chat is shown as the log with the outbox applied on top (`withPending` in `log.ts`), so a live entry never wipes out a pending change. TanStack Query is the store the UI reads; every change is written through, and the cache is filled from here on start so the app renders before the network answers. The session is remembered in `localStorage` and revalidated in the background. Signing out deletes the database.

- **D1:** Better Auth's `user` (plus `username` and `displayUsername`), `session`, `account`, `verification`.
- **UserDO SQLite:** `chat(chat_id, peer_id, last_seq, preview JSON with its rev, updated_at, read_seq, unread)` (the inbox), `push_sub(endpoint, keys)`.
- **ChatDO SQLite:** `member(user_id, role, read_seq, read_ts)`, `delivery(user_id, seq)` (fan-out progress), `event(seq PK, cid UNIQUE, sender, ts, kind, body, reply JSON, target, edited, deleted, reactions JSON, rev)` (the log: messages hold their current state; one reaction per person), `message_fts` (FTS5). Durable Object schemas change through `migrate()` in `durable-objects/schema.ts`: an append-only list of SQL migrations, each run once per object in a transaction. Never edit or remove a shipped migration, and never drop a table that holds user data.

## Build phases

Each phase lists what to build and when it counts as done.

0. **Foundations.** pnpm workspace, root `.env`, oxlint/oxfmt + husky, Better Auth + D1 + Drizzle, the `/login`, `/login/username` and `/` routes, CI (typecheck + build + deploy). _Done when:_ you can sign up with email or Google in production, pick a username and land on `/`.
1. **DMs end to end.** UserDO with a hibernating socket; ChatDO with `seq` and `cid` deduplication; RPC fan-out; inbox list; chat view with paginated history; sending. _Done when:_ two browsers can DM each other live in production.
2. **Reliability and local-first (the main differentiator).** IndexedDB cache (`idb`, not Dexie: Dexie costs 33 KB), outbox, per-chat cursors, gap repair, replay on reconnect; render from cache before the socket connects; optimistic sends with pending/sent/failed states. Chaos test: scripted clients plus forced disconnects plus a redeploy partway through, then assert that every client's log is identical. _Done when:_ the chaos test passes in CI, and turning on airplane mode, sending 5 messages and reconnecting delivers all 5 in order.
3. **Groups and core features.** Create, rename, add or remove members, roles (removing a member cuts off delivery immediately); replies, edits, deletes, reactions; read receipts via `read_seq`, unread counts, typing, presence; rate limits on send, connect and auth. _Done when:_ v2 has every feature v1 had.
4. **Media, voice messages and links.** Direct-to-R2 uploads with presigned PUTs, thumbnails from Image Transformations, a link-preview unfurler with a cache. Voice messages: record with `MediaRecorder` in a format every browser can play, upload through the same R2 path, and store a waveform computed while recording so the chat draws it without decoding audio. _Done when:_ images, voice messages and link cards render instantly from cache when you scroll back.
5. **Search and notifications.** FTS5 search per chat with jump-to-message; installable PWA; Web Push through Queues when a user has no live socket; per-chat mute. _Done when:_ a phone with the app closed gets a push notification, and search returns in under 50 ms.
6. **Prove it.** Latency sampling into Analytics Engine; a public `/status` page with p50/p95/p99; a load-test harness with results committed; a cost model in the README. Optional: a Workers AI "catch me up" summary of unread messages. _Done when:_ the README opens with real numbers and a chart.
7. **1:1 voice and video calls (stretch).** WebRTC between the two browsers, Cloudflare TURN for strict networks, and call signaling (ring, accept, decline, ICE) as ephemeral events over each user's existing UserDO socket. Ringing a closed app uses web push from phase 5. All call code is lazy-loaded. Group calls (Cloudflare Realtime SFU) come after. _Done when:_ two phones on different networks can call each other in production, and the call code adds 0 KB to the first load.

## Performance budget

| Metric                                    | Target             | How it's measured                                                                                                                                                                  |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS on the first load of a chat            | < 160 KB gzip      | Production build (`vite preview`), JS fetched when opening `/c/$chatId`, gzipped; check in CI. 156 KB after phase 3 read receipts; React (71) + TanStack Router (30) are the floor |
| Time to first chat visible (warm cache)   | < 150 ms           | `performance.mark` → Analytics Engine                                                                                                                                              |
| Send → ack, p50 (same region)             | < 50 ms            | Client timing per message                                                                                                                                                          |
| Send → peer receive, p99 (same continent) | < 150 ms           | Server timestamp vs. client receive time                                                                                                                                           |
| Messages lost or duplicated under chaos   | 0                  | Chaos test suite                                                                                                                                                                   |
| Inbox load                                | 1 DO read, < 30 ms | Worker timing                                                                                                                                                                      |

## Differentiators (each needs proof, not just a claim)

| Differentiator                          | Proof                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Exactly-once, gap-free delivery         | Chaos test that kills sockets and redeploys mid-stream, then asserts identical client logs |
| Works offline                           | Airplane mode, send 5 messages, reconnect: all 5 arrive in order                           |
| Small                                   | First-load JS budget enforced in CI, with a size report on every change                    |
| Read on one device, cleared everywhere  | Read state synced across a user's devices through their UserDO                             |
| Instant cold open from the local cache  | Recorded numbers comparing v1 and v2                                                       |
| Public live latency page                | `/status` with p50/p95/p99                                                                 |
| Actor-per-chat with zero servers to run | README cost model: $ per 1M messages and idle cost                                         |
| Per-chat FTS5 search                    | Search latency on a chat with 100k messages                                                |
| Load tested                             | Chart of latency against concurrency, and the breaking point                               |

Out of scope on purpose: end-to-end encryption (it would rule out server-side search and summaries), an "AI chatbot in the chat", and feature-list padding (stories, stickers, channels) that adds weight without proving anything.

## UI

Designs live in the Paper file "Bubbles". **Design first:** before building any new UI feature, or changing how an existing one looks, design it in Paper (add a screen or update the existing one) and get it right there; then implement it by hand from that design. Never ship UI that exists only in code. Build to those designs: the style is clean, fun and playful, and the app should feel good to use. Pull exact values with Paper's `get_jsx` and `get_computed_styles`, never from screenshots. Shared color, type and radius tokens live in `frontend/src/styles.css` as a Tailwind v4 `@theme`; shadcn's semantic tokens (`primary`, `muted-foreground`, …) map onto that palette in the `@theme inline` block. Add shadcn components with `pnpm dlx shadcn@latest add <name>` in `frontend/`, then restyle them to the Paper design. Import app code with the `@/` alias. Heavy, rarely used UI (dialogs, pickers) is loaded with `lazy()` on first hover or focus of its trigger, so it stays out of the first-load bundle. Fonts are self-hosted through Fontsource.

## Deploy

Production is `https://bubbles.sudoanmol.workers.dev`. Deploy `backend` before `frontend`, because the service binding needs `bubbles-api` to exist.

1. `pnpm -C backend db:migrate:remote`
2. Secrets, once per Worker change: `wrangler secret put <KEY>` in `backend/` for `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (`https://bubbles.sudoanmol.workers.dev`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
3. `pnpm -C backend deploy`, then `pnpm -C frontend deploy`

Google's OAuth client must list `https://bubbles.sudoanmol.workers.dev/api/auth/callback/google` as a redirect URI.
