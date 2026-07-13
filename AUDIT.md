# Bubbles — Code Audit Findings

Audit date: 2026-07-12. Scope: full backend (Go), frontend WebSocket/realtime layer (React/TanStack). Focus: WebSocket and connection handling. `go vet` passes clean. **Documentation only — nothing here has been fixed.**

---

## Critical — WebSocket & connection handling

### 1. Removed users keep receiving messages until they disconnect

Membership is validated only at `join_chat` time (`backend/websocket/hub.go:91`). None of the removal paths — `RemoveChatMember`, `LeaveChat`, `DeleteChat` (`backend/routes/chat_actions.go`) — notify the hub. A user kicked from a group stays subscribed in `ChatRooms` and continues receiving every message, typing event, and read receipt in that chat for the lifetime of their connection. This is an access-control hole, not just staleness.

**Fix direction:** membership-change endpoints call into the hub to evict the client from the room (and optionally send a synthetic `leave_chat`/`chat_removed` event so the UI updates).

### 2. Recipients of a new chat never join its room — realtime silently fails for them

Rooms are only joined in `ws.onopen` from the `['chats']` query cache (`frontend/src/contexts/websocket-context.tsx:68-103`). The only other `joinChat` call site is `new-chat-dialog.tsx:77` — the **creator's** side.

Consequences:

- On page load, if the WS handshake wins the race against the chats fetch, the cache is empty and the user joins **zero** rooms until a reconnect.
- When someone starts a new chat with you, you never join it until a full page reload. Nothing re-joins rooms when the chats query resolves or refetches.

**Fix direction:** join rooms reactively whenever the `['chats']` cache changes (e.g. an effect keyed on chat IDs), not only at socket open.

### 3. Slow clients silently and permanently lose messages

`BroadcastToChatExclude` drops the message when a client's send buffer is full (`backend/websocket/hub.go:151-153`) but keeps the connection alive. The client never learns it missed anything and never resyncs. The standard gorilla/websocket pattern closes the connection on a full buffer so the client reconnects and refetches. This also drops `typing_stop` events (see finding 12).

### 4. Reconnect after token expiry loops forever

The token comes from a `['authToken']` query fetched once (`frontend/src/contexts/websocket-context.tsx:46-52`) and never refetched. JWTs expire in 2h (`backend/routes/auth.go:47`). After expiry, every reconnect attempt fails the handshake with 401, `onclose` fires, and the client retries with the same dead token indefinitely. Only a page reload recovers.

Related: the backend validates the JWT only at upgrade time (`backend/routes/websocket.go:54`), so an open socket outlives its token indefinitely — combined with finding 1, revocation is effectively impossible.

### 5. Read receipts trust client-supplied data and can permanently poison unread counts

`HandleReadReceipt` (`backend/websocket/hub.go:168`) verifies the user is in the chat but:

- never verifies the **message** belongs to that chat (a message ID from another chat can be recorded);
- stores client-supplied `message_created_at` as `last_read_at`. A far-future timestamp gets locked in forever by `GREATEST(...)` in `UpsertChatReadReceipt` (`backend/sql/queries/messages.sql`) — all future messages count as read and legitimate receipts can never overwrite it.

**Fix direction:** look up the message server-side, verify `message.chat_id == chat_id`, and use the DB's `created_at`.

### 6. Reader's own devices never learn their read state; dead frontend handler

`HandleReadReceipt` broadcasts with `BroadcastToChatExclude(..., userID)` (`backend/websocket/hub.go:203`), excluding **all** connections of that user, including other tabs/devices. Meanwhile the `message_read` handler in `useChatListWebSocket` (`frontend/src/hooks/use-chat-websocket.ts:306-321`) only acts when `payload.user_id === currentUserId` — an event it can never receive. That handler is unreachable code; multi-tab unread badges desync.

### 7. The WS path has zero rate limiting or resource caps

The Redis rate limiter covers HTTP only. Over the socket a client can spam unlimited `join_chat`/typing events, each doing a synchronous DB query (`ValidateMembership`), with `maxMessageSize` set to 512KB (`backend/websocket/client.go:15`) for ~200-byte control messages. No cap on connections per user. Cheapest DoS surface in the app.

---

## High — correctness bugs (backend)

### 8. Edit/Delete message endpoints don't exist if R2 is unconfigured

`main.go:130-137` registers `/messages/edit` and `/messages/delete` only when `uploadHandler != nil`. Missing R2 env vars → editing a plain-text message 404s. Same coupling breaks chat deletion: `deleteChatWithAssets` (`backend/routes/chat_actions.go:612`) errors even for chats with no images.

### 9. R2 deletion interleaved with DB transactions in inconsistent orders

- `EditMessage` deletes R2 objects **inside** the open transaction (`backend/routes/messages.go:585-592`); if a later step fails, DB rows roll back but the objects are gone → broken image URLs.
- `DeleteMessage` deletes R2 **after** commit but **before** the broadcast (`backend/routes/messages.go:720-727`); an R2 failure returns 500 and skips the WebSocket broadcast — the message is deleted in the DB, the sender sees an error, other clients' UIs never update.

### 10. Rate limiter failure modes are backwards and inconsistent

- Redis down at boot → server continues with no rate limiting, silently (`backend/main.go:55-59`).
- Redis down at runtime → auth endpoints fail **closed** with 500s = login outage (`backend/middleware/rate_limit.go:98-105`), while user-based limits fail **open** (`c.Next()` on error). Pick one policy.

---

## High — correctness bugs (frontend)

### 11. Duplicate socket leak in `connect()`

The guard checks only `readyState === OPEN` (`frontend/src/contexts/websocket-context.tsx:55`). If called while a socket is `CONNECTING` (effect re-run on token/queryClient change), a second socket is created and overwrites `wsRef` — the first stays alive with active handlers, double-processing every event.

### 12. Typing indicators can get stuck forever

`frontend/src/hooks/use-typing-indicator.ts` has no TTL on `typingUsers`. If `typing_stop` is lost (dropped by finding 3, or the typist disconnects — the backend sends no synthetic stop on disconnect), "X is typing…" displays until the viewer switches chats. Standard fix: 3–5s expiry timer per typing user.

### 13. `isConnected` is always stale

`isConnected: isConnectedRef.current` (`frontend/src/contexts/websocket-context.tsx:206`) reads a ref during render; changing it never re-renders consumers. Should be `useState` (or removed — nothing meaningful can consume it as-is).

### 14. Pending-message replay resends stale typing events

The reconnect filter (`frontend/src/contexts/websocket-context.tsx:89-96`) ages out only `message_read`; queued `typing_start` from minutes ago replays on reconnect, triggering finding 12 for other viewers.

---

## Medium

### Backend

- **Graceful shutdown ignores WebSockets** — `srv.Shutdown` neither waits for nor closes hijacked connections; `hub.Run` has no stop; clients get no close frame (`backend/main.go:204-218`).
- **No timeouts on hub DB calls** — every hub query uses `context.Background()`; a slow DB blocks each client's `ReadPump` inline since join/typing are handled synchronously (`backend/websocket/hub.go:78,192`).
- **`EditMessage` can empty a message** — no "content or images required" check (unlike `SendMessage`), and it broadcasts `UpdatedAt: time.Now()` instead of the DB timestamp (`backend/routes/messages.go:631`).
- **Typing payload `profile_image_url` is client-controlled** and rebroadcast verbatim (`backend/websocket/client.go:82`) — spoofable. Typing also echoes back to the sender (`BroadcastToChat`, not `...Exclude`).
- **`CreateChat` returns 500 for a nonexistent member ID** (FK violation surfaces as internal error, `backend/routes/chat.go:162-174`); no cap on member count.
- **`SearchUsers` with nil `selected_user_ids` returns zero rows** — `id != ALL(NULL)` is never true. The UI always sends the array, so it's latent, but any caller omitting the field gets an empty result. Also: self-exclusion is delegated to the client, and user emails are exposed to any authenticated searcher.
- **JWT staleness on rename** — `sender_username` in broadcasts comes from token claims (`backend/routes/messages.go:445,461`); wrong for up to 2h after a username change.
- **Schema uses `TIMESTAMP` without time zone** while comparing against client-supplied timestamps (read receipts) — one timezone mismatch away from wrong unread counts.
- **`Sec-WebSocket-Protocol` parsing is brittle** — `strings.Split(protocols, ", ")` (`backend/routes/websocket.go:38`) breaks if a proxy normalizes to `,` without a space.
- **Health endpoint leaks raw DB error strings** (`backend/main.go:171-175`).
- **`username.(string)` type assertion without `ok`** in `SendMessage` broadcast (`backend/routes/messages.go:461`) — panics if the context value is ever missing (defensive only; middleware currently always sets it).

### Frontend

- **`leave_chat` is never sent** — `joinedChatsRef` only grows; the backend `EventLeaveChat` path is effectively unused.
- **Optimistic unread reset relies on a WS send that may be queued** — `sendReadReceipt` (`frontend/src/components/messages.tsx:130-153`) zeroes `unread_count` locally even if the socket is down and the receipt is later discarded by the 60s staleness filter.

---

## Complex abstractions that should be simpler

1. **The hub's mixed channel/mutex concurrency model is pure overhead.** `Register`/`Unregister` are channels processed by `Run()` (`backend/websocket/hub.go:37-63`), but all shared state is already guarded by `h.mu`, and `Subscribe/Unsubscribe/Broadcast` take the mutex directly. `Run()` adds a goroutine and ordering subtleties for zero benefit — make `Register`/`Unregister` plain mutex-guarded methods and delete the channels and the loop. Dead code alongside it: `Hub.Broadcast chan []byte` (never used) and `Client.email` (never read).

2. **`ValidateMembership` hits the DB when the hub already knows the answer.** After `join_chat`, room membership is in `ChatRooms`. Typing and read-receipt events could check "is this client subscribed to this room" (a map lookup) instead of a DB query per keystroke event. This removes the hot-path DB load _and_ most of the DoS surface in finding 7; once membership-change endpoints also update the hub (finding 1), the in-memory map becomes the single source of truth.

3. **`CreateChat` sorts `memberIds`, then copies and sorts again** into `sortedMemberIds` (`backend/routes/chat.go:96-107`) — the copy and second sort are dead code.

4. **Read-receipt semaphore + goroutine-per-receipt** (`backend/websocket/client.go:102-110`) exists mainly because each receipt does two DB round trips; with the membership check gone it's one upsert and could be a synchronous call or a single worker channel.

5. **`Unregister` scans every chat room on every disconnect** (`backend/websocket/hub.go:52-57`); having each `Client` track its own room set makes cleanup O(own rooms).

---

## Suggested fix order

1. Findings **1 + 2** together (hub eviction on membership change + reactive room joining from the chats cache) — the make-or-break pair for realtime correctness.
2. Finding **3** (close slow clients instead of silently dropping).
3. Finding **4** (refetch token before reconnect attempts).
4. Finding **5** (server-side validation of read-receipt message + timestamp).
5. Everything else roughly in listed order.
