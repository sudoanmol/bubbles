# Bubbles

A real-time chat app built entirely on Cloudflare. The goal is a production-grade chat app that is measurably fast: one actor per chat, one actor per user, one WebSocket per device, a local-first client, and published latency numbers.

Build it in layers. Every phase below ends with something that works end to end and can be deployed. Do not start a phase until the previous one works in production.

## Repository

pnpm workspace (never npm or bun):

```
backend/    Worker `bubbles-api` (private): Hono, auth, API, Durable Objects
  src/index.ts            app wiring: auth mount, session middleware, route mounts, DO exports
  src/routes/             one Hono router per resource (ws, inbox, dms, chats, users)
  src/durable-objects/    UserDO (user.ts), ChatDO (chat.ts)
  src/protocol.ts         wire protocol shared with the frontend (`import … from 'backend/protocol'`)
frontend/   Worker `bubbles` (public): TanStack Start, React 19, Tailwind v4, TanStack Query, shadcn (Base UI)
  src/routes/_app*        signed-in shell (inbox + open chat); `/`, `/c/$chatId`, `/@{$username}`
  src/hooks/              shared React hooks
  src/lib/                api + query cache helpers, socket client, auth, time formatting
  src/components/ui/      shadcn components; we own and restyle them
.env        the only env file, shared by every package (copy from .env.example)
```

| Task                 | Command (from the root)                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Install              | `pnpm install`                                                                                            |
| Sign in as any user  | Open `http://localhost:3100/api/dev/login/<username>` (local only; for testing two accounts side by side) |
| Dev (both workers)   | `pnpm dev` (app on :3100, API on :8790; the API restarts when `.env` changes)                             |
| Typecheck            | `pnpm typecheck`                                                                                          |
| Build                | `pnpm build`                                                                                              |
| Lint / format        | `pnpm lint`, `pnpm fmt` (oxlint + oxfmt; also run on pre-commit via husky + lint-staged)                  |
| Worker binding types | `pnpm -C <pkg> cf-typegen` after editing that package's `wrangler.jsonc`                                  |

Assume the dev server is already running. Verify work with `pnpm typecheck` and `pnpm build`.

### Conventions

- Add dependencies with `pnpm -C <pkg> add`. Never edit manifests by hand to add one.
- Secrets and config live in the root `.env`. The backend loads it with `wrangler dev --env-file ../.env`, wrapped in `node --watch-path` because wrangler does not watch env files. In production, use `wrangler secret put`. Add every new key to `.env.example`.
- Database access goes through Drizzle ORM. The Better Auth tables are generated, so never hand-edit them (see Auth).
- Parse all external input at the boundary: HTTP bodies, WebSocket frames, env.
- Do not keep backward compatibility. This is a rewrite, so delete obsolete paths.
- Prefer platform primitives (Durable Objects, D1, R2, Queues, Rate Limiting binding) over adding services.

## Architecture

```
Browser (IndexedDB cache, outbox, seq cursors, 1 WebSocket)
   │ one public origin: bubbles.sudoanmol.workers.dev
   ▼
bubbles (frontend Worker) ── TanStack Start, static assets; /api/* → service binding `API`
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
- **One origin, private API.** `frontend/src/server.ts` forwards `/api/*` to `bubbles-api` over the `API` service binding (no network hop). The API Worker has `workers_dev: false`, so it has no public URL. Cookie auth needs no CORS and no custom domain. The same path runs in dev: the Vite plugin reaches the local `wrangler dev` through the dev registry.
- **SSR is off** (`defaultSsr: false` in `frontend/src/start.ts`). The app renders on the client from the local cache. The server renders only the HTML shell.

### Stack

| Layer                  | Choice                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Frontend               | TanStack Start + Router, React 19 + Compiler, Tailwind v4                                        |
| Client data            | TanStack Query (all server state), Dexie for IndexedDB (phase 2)                                 |
| UI kit                 | shadcn on Base UI (`Message`, `Bubble`, `MessageScroller`, `Dialog`), lucide icons               |
| Socket client          | `partysocket` (reconnect with backoff)                                                           |
| API                    | Hono, one router per resource in `backend/src/routes/`                                           |
| Protocol               | Valibot schemas and response types in `backend/src/protocol.ts`; frames are parsed on both sides |
| Auth                   | Better Auth on D1 via the Drizzle adapter: email/password, username plugin, Google OAuth         |
| Storage                | DO SQLite (`new_sqlite_classes`, raw `ctx.storage.sql`), D1 + Drizzle, R2                        |
| Async                  | Queues → Web Push (VAPID)                                                                        |
| Limits / observability | Rate Limiting binding, Workers Logs, Analytics Engine                                            |
| Tooling                | oxlint, oxfmt, husky + lint-staged                                                               |

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

- **Idempotent sends.** The client generates `cid` (a ULID) and writes the message to its outbox before sending. `UNIQUE(cid)` in ChatDO makes retries harmless. The outbox is replayed on every reconnect.
- **Gap detection.** The client stores `lastSeq` for each chat. If a message arrives with `seq > lastSeq + 1`, the client fetches `GET /api/chats/:id/messages?after=lastSeq` before rendering it. On reconnect, UserDO returns each chat's `latestSeq`, and gaps are filled lazily when a chat is opened.
- **Deploys are routine.** A deploy drops sockets. The client reconnects, replays its outbox and fills any gaps.
- **Edits and deletes** are new events with a new `seq` (deletes are tombstones), so the gap logic covers them too.
- **Ephemeral events** (typing, presence) travel the same path but are never stored. Typing is throttled to one event every 3 seconds.
- **Known limits:** each DO lives in one location (near where it was created). A single DO handles roughly 1k req/s. Fan-out happens on every send, so groups are capped at about 256 members. Mark these limits with `ponytail:` comments in the code.

### Data model

- **D1:** Better Auth's `user` (plus `username` and `displayUsername`), `session`, `account`, `verification`.
- **UserDO SQLite:** `inbox(chat_id, last_seq, read_seq, unread, preview, updated_at)`, `push_sub(endpoint, keys)`.
- **ChatDO SQLite:** `member(user_id, role, read_seq)`, `message(seq PK, cid UNIQUE, sender, body, reply_to, attachments, edited_at, deleted_at, ts)`, `reaction(seq, user_id, emoji)`, `message_fts` (FTS5).

## Build phases

Each phase lists what to build and when it counts as done.

0. **Foundations.** pnpm workspace, root `.env`, oxlint/oxfmt + husky, Better Auth + D1 + Drizzle, the `/login`, `/login/username` and `/` routes, CI (typecheck + build + deploy). _Done when:_ you can sign up with email or Google in production, pick a username and land on `/`.
1. **DMs end to end.** UserDO with a hibernating socket; ChatDO with `seq` and `cid` deduplication; RPC fan-out; inbox list; chat view with paginated history; sending. _Done when:_ two browsers can DM each other live in production.
2. **Reliability and local-first (the main differentiator).** Dexie cache, outbox, per-chat cursors, gap repair, replay on reconnect; render from cache before the socket connects; optimistic sends with pending/sent/failed states. Chaos test: scripted clients plus forced disconnects plus a redeploy partway through, then assert that every client's log is identical. _Done when:_ the chaos test passes in CI, and turning on airplane mode, sending 5 messages and reconnecting delivers all 5 in order.
3. **Groups and core features.** Create, rename, add or remove members, roles (removing a member cuts off delivery immediately); replies, edits, deletes, reactions; read receipts via `read_seq`, unread counts, typing, presence; rate limits on send, connect and auth. _Done when:_ v2 has every feature v1 had.
4. **Media and links.** Direct-to-R2 uploads with presigned PUTs, thumbnails from Image Transformations, a link-preview unfurler with a cache. _Done when:_ images and link cards render instantly from cache when you scroll back.
5. **Search and notifications.** FTS5 search per chat with jump-to-message; installable PWA; Web Push through Queues when a user has no live socket; per-chat mute. _Done when:_ a phone with the app closed gets a push notification, and search returns in under 50 ms.
6. **Prove it.** Latency sampling into Analytics Engine; a public `/status` page with p50/p95/p99; a load-test harness with results committed; a cost model in the README. Optional: a Workers AI "catch me up" summary of unread messages. _Done when:_ the README opens with real numbers and a chart.

## Performance budget

| Metric                                    | Target             | How it's measured                        |
| ----------------------------------------- | ------------------ | ---------------------------------------- |
| JS on the first load of the app           | < 120 KB gzip      | Build output check in CI                 |
| Time to first chat visible (warm cache)   | < 150 ms           | `performance.mark` → Analytics Engine    |
| Send → ack, p50 (same region)             | < 50 ms            | Client timing per message                |
| Send → peer receive, p99 (same continent) | < 150 ms           | Server timestamp vs. client receive time |
| Messages lost or duplicated under chaos   | 0                  | Chaos test suite                         |
| Inbox load                                | 1 DO read, < 30 ms | Worker timing                            |

## Differentiators (each needs proof, not just a claim)

| Differentiator                          | Proof                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Exactly-once, gap-free delivery         | Chaos test that kills sockets and redeploys mid-stream, then asserts identical client logs |
| Instant cold open from the local cache  | Recorded numbers comparing v1 and v2                                                       |
| Public live latency page                | `/status` with p50/p95/p99                                                                 |
| Actor-per-chat with zero servers to run | README cost model: $ per 1M messages and idle cost                                         |
| Per-chat FTS5 search                    | Search latency on a chat with 100k messages                                                |
| Load tested                             | Chart of latency against concurrency, and the breaking point                               |

Out of scope on purpose: end-to-end encryption (it would rule out server-side search and summaries) and an "AI chatbot in the chat."

## UI

Designs live in the Paper file "Bubbles". **Design first:** before building any new UI feature, or changing how an existing one looks, design it in Paper (add a screen or update the existing one) and get it right there; then implement it by hand from that design. Never ship UI that exists only in code. Build to those designs: the style is clean, fun and playful, and the app should feel good to use. Pull exact values with Paper's `get_jsx` and `get_computed_styles`, never from screenshots. Shared color, type and radius tokens live in `frontend/src/styles.css` as a Tailwind v4 `@theme`; shadcn's semantic tokens (`primary`, `muted-foreground`, …) map onto that palette in the `@theme inline` block. Add shadcn components with `pnpm dlx shadcn@latest add <name>` in `frontend/`, then restyle them to the Paper design. Import app code with the `@/` alias. Heavy, rarely used UI (dialogs, pickers) is loaded with `lazy()` on first hover or focus of its trigger, so it stays out of the first-load bundle. Fonts are self-hosted through Fontsource.

## Deploy

Production is `https://bubbles.sudoanmol.workers.dev`. Deploy `backend` before `frontend`, because the service binding needs `bubbles-api` to exist.

1. `pnpm -C backend db:migrate:remote`
2. Secrets, once per Worker change: `wrangler secret put <KEY>` in `backend/` for `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (`https://bubbles.sudoanmol.workers.dev`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
3. `pnpm -C backend deploy`, then `pnpm -C frontend deploy`

Google's OAuth client must list `https://bubbles.sudoanmol.workers.dev/api/auth/callback/google` as a redirect URI.
