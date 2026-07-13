# Bubbles

A real-time chat application with direct messages and group chats, built with TanStack Start and Go. Messages, edits, deletions, typing indicators, and read receipts are all delivered live over WebSockets.

## Key Features

- **Real-time messaging** — instant delivery, editing, and deletion over a single WebSocket connection per client
- **Direct messages and group chats** — with member management (add/remove members, rename groups, transfer admin)
- **Message features** — replies, typing indicators, read receipts, and link detection
- **Unread tracking** — per-chat unread counts that stay in sync across tabs and devices
- **Auth with rotating refresh tokens** — 2-hour JWTs renewed transparently, sessions survive without re-login
- **Image sharing** — up to 5 images per message, stored in Cloudflare R2
- **User profiles** — customizable avatars and usernames
- **Chat management** — clear history, delete, leave; removed members are evicted from live connections immediately
- **Responsive design** with dark mode support

## Tech Stack

### Frontend

- [React](https://react.dev) with the [React Compiler](https://react.dev/learn/react-compiler)
- [TanStack Start](https://tanstack.com/start) full-stack React framework (server functions handle all backend calls)
- [TanStack Query](https://tanstack.com/query) for data fetching, caching, and optimistic updates
- [TanStack Form](https://tanstack.com/form) + [Zod](https://zod.dev) for forms and validation
- [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) for styling and components
- [Bun](https://bun.sh) as package manager and script runner
- Deployed to [Cloudflare Workers](https://workers.cloudflare.com) via Wrangler

### Backend

- [Go](https://go.dev) with the [Gin](https://gin-gonic.com) HTTP framework
- [gorilla/websocket](https://github.com/gorilla/websocket) for the realtime hub
- [PostgreSQL](https://www.postgresql.org) for persistence, [sqlc](https://sqlc.dev) for type-safe queries, [goose](https://github.com/pressly/goose) for migrations
- [Redis](https://redis.io) backing [ulule/limiter](https://github.com/ulule/limiter) for rate limiting
- [Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) (S3-compatible) for image storage
- [air](https://github.com/air-verse/air) for live reloading, [Docker](https://www.docker.com) for local databases
- Deployed to [Railway](https://railway.app)

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- [Go](https://go.dev) 1.24+
- [Docker](https://www.docker.com) (for local PostgreSQL and Redis)
- A Cloudflare R2 bucket (optional — image upload/editing degrades gracefully without it)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/anmol7470/bubbles.git
cd bubbles
```

### 2. Install dependencies

```bash
bun install            # root: mprocs, husky, prettier
cd frontend && bun install && cd ..
```

### 3. Set up environment variables

```bash
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
```

Then edit both files — at minimum set `SESSION_SECRET` (frontend) and `JWT_SECRET` (backend) to long random strings. See [Environment Variables](#environment-variables) for the full reference.

### 4. Install Go development tools (air, sqlc, goose)

```bash
cd backend
make install-tools
```

### 5. Start PostgreSQL + Redis and run migrations

```bash
make docker-up
make migrate-up
cd ..
```

### 6. Start the development servers

```bash
bun run dev
```

This uses [mprocs](https://github.com/pvolok/mprocs) to run the frontend (port 3000, `bun run dev` in `frontend/`) and backend (port 8000, `make dev` in `backend/`) concurrently. Open [http://localhost:3000](http://localhost:3000).

## Architecture

### Directory Structure

```
bubbles/
├── frontend/                  # TanStack Start app (deployed to Cloudflare Workers)
│   ├── src/
│   │   ├── components/        # UI components (chat, messages, dialogs, shadcn/ui)
│   │   ├── contexts/          # WebSocket provider (connection, rooms, event bus)
│   │   ├── hooks/             # Chat cache updates, typing indicator, uploads, scroll
│   │   ├── routes/            # TanStack Router file-based routes
│   │   ├── server/            # Server functions (auth, chat, session) — the only
│   │   │                      #   code that talks to the Go API directly
│   │   └── types/             # Shared TypeScript types
│   ├── wrangler.jsonc         # Cloudflare Workers deployment config
│   └── vite.config.ts
│
├── backend/                   # Go API + WebSocket server
│   ├── routes/                # HTTP handlers (auth, chats, messages, uploads, ws)
│   ├── middleware/            # Gin middleware (JWT auth, Redis rate limiting)
│   ├── websocket/             # Hub: rooms, membership, broadcasting, eviction
│   ├── database/              # sqlc-generated query code
│   ├── sql/
│   │   ├── schema/            # goose migrations
│   │   └── queries/           # sqlc query definitions
│   ├── models/                # Request/response types
│   ├── utils/                 # Helpers, security logger
│   ├── docker-compose.yml     # Local PostgreSQL + Redis
│   └── Makefile               # All backend commands
│
├── mprocs.yaml                # Runs both dev servers
└── package.json               # Root tooling (mprocs, husky, prettier)
```

### How Requests Flow

The browser never calls the Go API directly. Every HTTP request goes through a TanStack Start **server function**, which reads the JWT from an encrypted, http-only session cookie and forwards the request with a `Bearer` token:

```
Browser → server function (Workers/Node) → Go API → PostgreSQL
                   │
                   └── session cookie holds { token, refreshToken, user }
```

The WebSocket is the exception: the browser connects to the Go server directly (`/ws`), passing the JWT via the `Sec-WebSocket-Protocol` header (fetched from the session by a server function).

### Authentication

- **Sign in/up** returns a 2-hour JWT plus a 30-day opaque refresh token; both are stored server-side in the session cookie.
- **Transparent renewal**: before any authenticated call, the server function checks the JWT's expiry and, when it is about to lapse, exchanges the refresh token at `POST /auth/refresh`. Tokens rotate on every refresh; rotated tokens stay valid for a 30-second grace window so concurrent requests don't race each other into a logout.
- Refresh tokens are stored hashed (SHA-256) in the `refresh_tokens` table and revoked on logout. Expired and rotated rows are purged daily.
- The WebSocket server closes a connection the moment its JWT expires; the client reconnects with a freshly renewed token.

### Realtime Design

The Go server keeps one **hub** with an in-memory map of chat rooms → connected clients:

- Clients `join_chat` for every chat in their list (validated against the DB once per join); afterwards, per-event authorization (typing, read receipts) is an in-memory room lookup — no DB hit per keystroke.
- Membership changes push state to the hub: removing a member or deleting a chat **evicts** their connections from the room and sends `chat_removed`; creating a chat or adding a member sends `chat_created` so the recipient joins the room live, without a reload.
- Slow consumers (full send buffer) are disconnected so they reconnect and refetch, rather than silently missing messages.
- Each connection is rate-limited with a token bucket, capped at 8 connections per user, and read-limited to 4 KB frames.

**Client → server events:** `join_chat`, `leave_chat`, `typing_start`, `typing_stop`, `message_read`
**Server → client events:** `message_sent`, `message_edited`, `message_deleted`, `message_read`, `typing_start`, `typing_stop`, `chat_created`, `chat_removed`

On the frontend, a single `WebSocketProvider` owns the connection, re-joins rooms reactively whenever the chats cache changes, replays queued read receipts after reconnecting, and reconnects with exponential backoff. Incoming events update the TanStack Query cache directly (`['chats']`, `['messages', chatId]`), so the UI is a pure function of the cache.

### Database Schema

```
users                     chats                      chat_members
├── id (uuid, PK)         ├── id (uuid, PK)          ├── id (uuid, PK)
├── username (unique)     ├── name                   ├── chat_id (FK → chats)
├── email (unique)        ├── is_group               ├── user_id (FK → users)
├── password_hash         ├── created_by (FK)        ├── joined_at
├── profile_image_url     └── created/updated_at     ├── cleared_at   # "clear chat" per member
└── created/updated_at                               └── deleted_at   # soft-delete for DMs

messages                  images                     chat_read_receipts
├── id (uuid, PK)         ├── id (uuid, PK)          ├── chat_id + user_id (PK)
├── chat_id (FK)          ├── message_id (FK)        ├── last_read_message_id (FK)
├── sender_id (FK)        └── url                    └── last_read_at
├── content
├── is_deleted            refresh_tokens
├── is_edited             ├── id (uuid, PK)
├── reply_to_message_id   ├── user_id (FK)
└── created/updated_at    ├── token_hash (unique)    # SHA-256, plaintext never stored
                          ├── expires_at
                          └── revoked_at             # rotation grace window
```

All timestamps are `TIMESTAMPTZ`. Direct messages are soft-deleted per member (`deleted_at`) and hard-deleted once both sides delete; group chats are hard-deleted by the admin. Unread counts are computed from `chat_read_receipts` at query time.

### Rate Limits

| Scope         | Limit | Window | Keyed by |
| ------------- | ----- | ------ | -------- |
| Sign in/up    | 5     | 10 min | IP       |
| Token refresh | 60    | 10 min | IP       |
| User search   | 30    | 1 min  | User     |
| Send message  | 60    | 1 min  | User     |
| Image upload  | 20    | 1 min  | User     |

If Redis is unavailable, limits fail open (requests proceed, errors are logged) so a Redis outage never becomes a login outage.

## Environment Variables

### Frontend (`frontend/.env`)

| Variable           | Description                                    | Example                   |
| ------------------ | ---------------------------------------------- | ------------------------- |
| `VITE_BACKEND_URL` | Go API base URL                                | `http://localhost:8000`   |
| `VITE_WS_URL`      | WebSocket endpoint                             | `ws://localhost:8000/ws`  |
| `SESSION_SECRET`   | Encrypts the session cookie (32+ random chars) | `openssl rand -base64 32` |

### Backend (`backend/.env`)

| Variable                    | Description                             | Default / Example                    |
| --------------------------- | --------------------------------------- | ------------------------------------ |
| `FRONTEND_URL`              | Allowed CORS/WebSocket origin           | `http://localhost:3000`              |
| `DATABASE_URL`              | PostgreSQL connection string            | matches `docker-compose.yml`         |
| `REDIS_URL`                 | Redis connection string (rate limiting) | `redis://localhost:6379/0`           |
| `JWT_SECRET`                | HMAC secret for JWTs (required)         | `openssl rand -base64 32`            |
| `JWT_EXPIRY_HOURS`          | Access token lifetime                   | `2`                                  |
| `REFRESH_TOKEN_EXPIRY_DAYS` | Refresh token lifetime                  | `30`                                 |
| `BCRYPT_COST`               | Password hashing cost                   | `12`                                 |
| `PORT`                      | HTTP listen port                        | `8000`                               |
| `R2_ACCOUNT_ID`             | Cloudflare account ID                   | optional — uploads disabled if unset |
| `R2_ACCESS_KEY_ID`          | R2 access key                           | optional                             |
| `R2_SECRET_ACCESS_KEY`      | R2 secret key                           | optional                             |
| `R2_BUCKET_NAME`            | R2 bucket name                          | optional                             |
| `R2_PUBLIC_URL`             | Public base URL for uploaded images     | optional                             |

## Available Scripts

### Root

| Command       | Description                                |
| ------------- | ------------------------------------------ |
| `bun run dev` | Start frontend + backend together (mprocs) |

### Frontend (`frontend/`)

| Command              | Description                            |
| -------------------- | -------------------------------------- |
| `bun run dev`        | Vite dev server on port 3000           |
| `bun run build`      | Production build                       |
| `bun run typecheck`  | `tsc --noEmit`                         |
| `bun run test`       | Vitest                                 |
| `bun run deploy`     | Build and deploy to Cloudflare Workers |
| `bun run cf-typegen` | Generate Workers types                 |

### Backend (`backend/`) — via Makefile

| Command               | Description                             |
| --------------------- | --------------------------------------- |
| `make dev`            | Run with hot reload (air)               |
| `make build`          | Compile to `tmp/main`                   |
| `make docker-up`      | Start PostgreSQL + Redis containers     |
| `make docker-down`    | Stop containers                         |
| `make docker-reset`   | Reset databases (destroys data)         |
| `make migrate-up`     | Apply pending migrations (goose)        |
| `make migrate-down`   | Roll back the last migration            |
| `make migrate-status` | Show migration status                   |
| `make sqlc-gen`       | Regenerate query code after editing SQL |
| `make format`         | `gofmt` the codebase                    |
| `make install-tools`  | Install air, sqlc, and goose            |

The typical loop for schema changes: add a migration in `backend/sql/schema/`, update queries in `backend/sql/queries/`, then `make migrate-up && make sqlc-gen && make build`.

## Deployment

### Frontend — Cloudflare Workers

Configured in `frontend/wrangler.jsonc`. Production values for `VITE_BACKEND_URL` / `VITE_WS_URL` live in the `vars` block; set `SESSION_SECRET` as a Workers secret:

```bash
cd frontend
bunx wrangler secret put SESSION_SECRET
bun run deploy
```

### Backend — Railway (or any container host)

The backend is a single Go binary. On Railway, point a service at `backend/`, attach PostgreSQL and Redis, and set the environment variables above (`FRONTEND_URL` must be the Workers URL, with `https://`). Run migrations against the production database:

```bash
cd backend
DATABASE_URL=<production-url> make migrate-up
```

The server shuts down gracefully on SIGTERM: in-flight requests get 10 seconds and WebSocket clients receive close frames.

## Todos

- [x] Add r2 storage for images
- [x] Fix message content styling taking inspiration from whatsapp
- [x] Add websocket for real-time chat for sending, deleting, editing messages, and typing indicators
- [x] Add read receipts for messages
- [x] Add unread message count for chats
- [x] Context menu to manage chats - Delete, Leave. Rename, Add/remove members if group chat
- [x] Add profile picture and username changes for users
- [x] Message reply to feature
- [x] Add refresh tokens for seamless session renewal
- [ ] Add voice message support??
- [ ] Add online/offline status for DMs
- [ ] Add message reactions
- [ ] Add mentions in group chats
- [ ] Add email verification on sign up
