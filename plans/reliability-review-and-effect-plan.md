# Reliability review and Effect refactor plan

Reviewed on 2026-10-27 against Bubbles commit `2a1f8e6`.

This document combines the code review, useful regression tests, and a proposed Effect refactor. It is a plan, not an implementation. No application fixes, Effect dependency, or Git subtree have been added.

The pre-existing untracked `backend/src/durable-objects/schema.ts` was inspected but left untouched.

## Status (2026-10-28, after the fixes)

Fixed on `new-rewrite`, uncommitted. `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (`tests/rules.ts`, `tests/store.ts`, `backend/test/`) and `pnpm chaos` with the mid-run redeploy all pass (1198/1198 entries, every client matches the server). Still open: the three visible UI changes (storage-failure state, a history Retry control, disabled image-button styling), which need Paper designs first.

| Finding                   | Status               | Fix                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 fan-out forgotten      | Fixed                | ChatDO `delivery(user_id, seq)` cursor per member, ordered batches, alarm armed with every write and re-armed on failure, backing off from 5 s to 5 min                                                                                                                                  |
| R2 send before commit     | Fixed                | One ordered queue in `socket.ts`: store, then send. Storage failure is logged, not shown in the UI                                                                                                                                                                                       |
| R3 cross-account writes   | Fixed                | `checkAccount(uid)` after every network await that then stores; another account signing in reloads the tab                                                                                                                                                                               |
| R4 reconciliation         | Fixed                | `merge` keys by `seq`, never lowers `rev`, and folds the newest patch into its message whatever the arrival order; IndexedDB never lowers `rev`                                                                                                                                          |
| R5 inbox projection       | Fixed                | Shared `nextPreview` with `rev` in `protocol.ts`; delivery is now in `seq` order per member                                                                                                                                                                                              |
| R6 pending overwritten    | Fixed                | Confirmed log and outbox are separate queries; display is `withPending(log, outbox)`                                                                                                                                                                                                     |
| R7 temporary vs permanent | Fixed                | ChatDO returns refusals; any other failure closes the socket and the outbox replays; replay skips refused sends                                                                                                                                                                          |
| R8 sign-out hang          | Fixed                | `blocking` handler closes the connection in other tabs; sign-out no longer awaits deletion                                                                                                                                                                                               |
| R9 first connect          | Fixed                | Catch-up runs on every open                                                                                                                                                                                                                                                              |
| R10 history stuck         | Fixed without new UI | Two automatic retries, then reset when the connection comes back. A visible Retry control still needs a Paper design                                                                                                                                                                     |
| R11 chaos script          | Fixed                | Reverts only its own edit; deletes only its own run's accounts                                                                                                                                                                                                                           |
| R12 UI gaps               | Fixed                | Image button `disabled`; opening a DM refreshes the inbox                                                                                                                                                                                                                                |
| Types                     | Fixed                | `Message` is a discriminated union (`patch` ⇒ numeric `target`, no `target!`); `withPending` returns only messages; `Pending` is a union; `merge` takes full entries                                                                                                                     |
| Tests                     | Fixed                | `tests/rules.ts` (every arrival order), `tests/store.ts` (fake-indexeddb: rev guard, outbox across reloads, two-tab sign-out), `backend/test/` (Workers runtime: fan-out after failure, eviction and alarm, with backoff). Each fails with its fix reverted. Not covered: a real browser |

Effect: not adopted. After these fixes the error policy is two cases and the durable part is SQLite plus an alarm, so Effect would wrap about 40 lines without removing a rule. Revisit when push (Queues) and calls add more async workflows with several retry policies.

## Summary

The application is small. Its main problem is that several parts implement different versions of the same delivery and state rules.

The highest-priority fixes are:

1. Persist delivery work so failed fan-out is not forgotten after acknowledgment.
2. Commit the browser outbox before sending.
3. Prevent work from one account from writing into another account's store.
4. Make message reconciliation revision-safe and independent of arrival order.

**The recommended Effect adoption is deliberately small and backend-only at first.** Typed failures, selective retries, and bounded fan-out are a good fit. The larger reliability repair is mostly data modeling, persistence, and lifecycle work. Rewriting that work with Effect does not remove the need to get those rules right.

## Scope and evidence

Reviewed the shared protocol, Durable Objects, routes, browser store/socket/query code, account lifecycle, chat UI, and existing chaos script.

Evidence labels used below:

- **Reproduced:** production functions exercised in isolated Node probes with controlled dependencies. Server projection probes used in-memory SQLite. Browser persistence and transport probes used controlled adapters, not a real browser.
- **Inspected:** a concrete failure path identified in source, without a full end-to-end reproduction.

Validation during the review:

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- Isolated probes reproduced the reconciliation, outbox ordering, failed fan-out, inbox ordering, optimistic-state, and account-cancellation problems described below.
- The first cancellation probe stopped on TanStack Query's expected `CancelledError`. A follow-up handled cancellation explicitly and confirmed that the persistence callback still ran.
- No browser or real Cloudflare-runtime tests ran.
- Build and chaos were not run during the read-only review. Build generates files; chaos writes source files and test data.
- Probe scripts were run in memory and were not added as a regression suite.

File and line references below describe the reviewed revision and may move after fixes.

## Findings

### R1. Failed fan-out is forgotten after acknowledgment

**Priority: high. Evidence: reproduced.**

Locations: `backend/src/durable-objects/chat.ts:68–70,107–115`.

`Promise.allSettled()` discards delivery failures. A retry of the original frame returns its stored event without attempting delivery again.

If the recipient's UserDO is unavailable during the first message in a DM, the message can be committed and acknowledged without the chat appearing in that recipient's inbox. The message is not lost from ChatDO, but inbox refresh cannot discover it.

Smallest useful correction:

- Record pending recipient delivery work durably with the event.
- Retry pending deliveries independently of client retries.
- Make recipient application idempotent and safe under reordering.
- Remove pending work only after the recipient confirms durable application.

Effect can organize retry policy, concurrency, and failure reporting. It cannot replace durable delivery state.

### R2. Transmission does not wait for the outbox commit

**Priority: high. Evidence: reproduced.**

Locations: `frontend/src/lib/socket.ts:132–135,149–151,165–167`; `frontend/src/lib/store.ts:49–57`.

Send, patch, and retry paths call `void saveOutbox(pending)` and schedule transmission immediately. A delayed persistence probe confirmed that `socket.send()` runs before the write finishes.

A reload or crash in that window can lose an unacknowledged operation. The store wrapper also catches persistence failures and returns a fallback, so the caller cannot tell whether the operation is durable.

Smallest useful correction:

- Persist and await the transaction before transmission.
- Preserve write order while waiting for persistence.
- Report storage failure explicitly. Do not claim reload-safe offline delivery when persistence failed.
- Distinguish disposable cache reads from required outbox writes rather than giving both the same silent fallback policy.

This does not require Effect.

### R3. Old-account requests can write into the next account's database

**Priority: high. Evidence: cancellation path reproduced; session-change path inspected.**

Locations: `frontend/src/lib/api.ts:81–91`; `frontend/src/lib/store.ts:18–35,50–54`; `frontend/src/routes/_app.tsx:33–36`.

Queries write through a mutable global `current` store. They do not consume TanStack Query's cancellation signal.

Clearing the query client cancels its result, but the asynchronous query function can continue. If account A's HTTP response arrives after account B opens its store, the persistence callback can target B's database.

Separately, background session validation only invalidates the router when the session becomes `null`. A change from one user ID to another is not handled.

Smallest useful correction:

- Bind requests and persistence to the account that started them.
- Forward cancellation signals to fetch, but also reject stale-account completions. Cancellation alone is not an identity check.
- Close the old socket and database connection on account change.
- Reset or partition query state when the user ID changes.

An account-scoped object plus `AbortController` is enough to start. Effect resource scopes are a later option, not a prerequisite.

### R4. Reconciliation is not revision-safe or order-independent

**Priority: high. Evidence: reproduced.**

Locations: `frontend/src/lib/store.ts:95–108`; `frontend/src/lib/api.ts:148–163`.

There are two failures:

1. IndexedDB unconditionally calls `store.put(m)`. A stale HTTP response can overwrite a newer edited or deleted message and decrease its `rev`.
2. `merge()` only folds a patch into its target when the patch arrives. If the patch arrives first and its older target arrives later, the already-held patch is not applied.

Both violate the documented "higher revision wins, in any order" contract. The second case can occur when a live patch beats the HTTP response containing its target.

Smallest useful correction:

- Never replace confirmed message state with a lower revision in memory or persistence.
- When a target arrives, reconcile it against already-held patches.
- Apply the same state-selection rule in the memory and IndexedDB paths.
- Keep the event log and the materialized message state conceptually separate, even if they share storage.

Effect does not help choose the correct revision. Keep this logic pure and test it with arrival-order permutations.

### R5. Inbox projections drop legitimate out-of-order updates

**Priority: medium. Evidence: reproduced against UserDO; browser equivalent inspected.**

Locations: `backend/src/durable-objects/user.ts:66–85`; `frontend/src/lib/api.ts:179–196`.

Both implementations use the highest observed event sequence to decide whether a preview can change.

Example:

1. An edit at sequence 2 arrives before its original message at sequence 1.
2. `lastSeq` advances to 2, but there is no preview to edit.
3. The original message arrives and is ignored because its sequence is lower.

The inbox can remain blank or show an older message.

Correction: represent the preview's message identity and applied revision separately from the highest observed log event. Repair incomplete projections rather than treating a maximum sequence as proof of completeness.

### R6. Confirmed updates overwrite still-pending optimistic operations

**Priority: medium. Evidence: reproduced.**

Locations: `frontend/src/lib/socket.ts:139–151`; `frontend/src/lib/api.ts:31–42,148–163`.

Optimistic patches modify the same objects used for confirmed state. Outstanding operations are reapplied during hydration, but not after every incoming event or acknowledgment.

A remote reaction can resurrect a locally deleted message while the deletion remains pending. An earlier edit's acknowledgment can overwrite a later optimistic edit.

Correction:

- Retain confirmed state independently.
- Derive displayed state by applying outstanding operations in order.
- Recompute that view after remote events, acknowledgments, rejections, and hydration.
- Rejecting one operation must not discard unrelated later operations.

### R7. Temporary failure and permanent rejection have conflicting behavior

**Priority: medium. Evidence: error handling inspected; failed-entry replay reproduced.**

Locations: `backend/src/durable-objects/user.ts:57–62`; `frontend/src/lib/socket.ts:62,182–190`.

Every RPC exception becomes the same error frame:

- A temporary failure drops a patch from the outbox.
- A rejected send stays as "Not sent", but reconnect automatically sends it again because replay includes failed entries.

The UI presents an explicit Retry decision while the transport silently makes that decision itself.

Correction: define stable error codes and retryability. Temporary failures stay pending. Permanent refusals follow the explicit Retry/Delete behavior. Treat unknown commit outcomes as retryable with the same `cid`, not as proof that the operation was rejected.

This is the strongest initial fit for Effect's typed error channel and selective retries.

### R8. Sign-out can hang while another tab holds the database open

**Priority: medium. Evidence: inspected, not browser-tested.**

Locations: `frontend/src/lib/store.ts:26–34,41–46`; `frontend/src/components/sidebar.tsx:22–27`.

Sign-out awaits database deletion before clearing the UI. Another tab can block deletion, and the IndexedDB connection has no version-change handler to release it.

Correction: coordinate logout between tabs, close blocking connections, and leave the signed-in UI promptly even if storage cleanup is still pending. Account teardown must also cover the delayed-work problem in R3.

### R9. The first WebSocket connection skips catch-up

**Priority: medium. Evidence: first-open behavior reproduced; missed-event scenario inspected.**

Location: `frontend/src/lib/socket.ts:58–67`.

Catch-up runs only when `opened` is already true. An event committed after the initial HTTP snapshot but before socket registration can be missed until another event, focus, or reconnect triggers repair.

Correction: synchronize after every successful connection, including the first. Preserve outbox ordering without making initial catch-up depend on having connected before.

### R10. History loading stays errored after a temporary failure

**Priority: medium. Evidence: inspected.**

Location: `frontend/src/routes/_app/c/$chatId.tsx:284–315`.

Automatic loading requires an idle mutation. After failure it stays errored, with neither a retry control nor a reconnect reset.

Correction: provide a bounded retry/reconnect path and an explicit retry action. Verify that it does not create an infinite request loop when the sentinel remains visible.

### R11. The chaos script can overwrite unrelated work

**Priority: medium. Evidence: inspected.**

Locations: `tests/chaos.ts:225–228,230–253`.

The exit handler unconditionally restores a source snapshot, including when `REDEPLOY=0`. This can overwrite edits made after the script starts. Database cleanup deletes all `@chaos.test` accounts rather than only those created by the current run.

Correction: avoid source rewriting where possible. If retained, restore only edits owned by the run after checking the current content. Limit account cleanup to recorded IDs for that run.

### R12. Smaller UI behavior gaps

**Priority: low. Evidence: inspected.**

- `frontend/src/components/composer.tsx:136–143`: the enabled image button has no action.
- `frontend/src/components/new-chat-dialog.tsx:30–35`: successful DM creation does not update or invalidate the inbox. An empty new chat can be absent from the sidebar until another refresh.

Correction: do not expose an enabled control for an unimplemented action; update inbox state after opening a DM. Follow the repository's Paper-first rule for visible UI changes.

## Slop, weak types, and unnecessary complexity

These are specific cleanup opportunities, not claims about who wrote the code.

### Replace misleading guarantees with enforced invariants

"Outbox first" and "higher revision wins in any order" currently describe intentions rather than behavior. Fix the behavior and protect it with tests.

The local store is not entirely disposable. Its outbox holds unsent user data that does not exist on the server. Cache-reset and schema-upgrade policies must preserve it or explicitly account for losing it.

### Strengthen types where the code already needs assertions

- `Message` permits `kind: 'patch'` with `target: null`.
- `Pending` permits a send without its optimistic `local` message.
- `merge()` accepts broad partial messages and casts the result back to `LocalMessage`.
- The conditional type in `patchMessage()` makes a small operation harder to read.

Use discriminated unions for events and pending operations. Separate complete server entries, optimistic operations, and local status updates. Do not add a large generic type framework or brand every primitive just to increase type complexity.

### Consolidate state rules, not every adapter

Memory, IndexedDB, server inbox, browser inbox, and the chaos client contain overlapping reconciliation rules. Extract the pure rules that must agree; keep storage and transport adapters small and explicit.

Do not solve duplication by building a generic repository, event bus, or service framework for this application.

### Remove scaffolding only when its purpose is resolved

- `backend/src/durable-objects/schema.ts` has no callers. It is pre-existing untracked work and should not be deleted automatically.
- `MessageAvatar` and `MessageHeader` had no consumers. Removed.

The pure `applyPatch()` function, thin Hono routes, `idb`, and lazy-loaded dialogs are good choices to preserve.

## Regression tests that would earn their keep

There is an existing `tests/chaos.ts`, but no focused browser or unit suite was found. The chaos script implements its own client and repairs history differently from the browser. Passing it does not prove the browser outbox or cache is correct.

| Test area                           | Observable contract                                                                                                          | Findings covered |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Reconciliation permutations         | The highest confirmed revision wins across duplicate events, late targets, stale snapshots, edits, reactions, and tombstones | R4, R5           |
| Pending-operation overlay           | Incoming events and earlier acknowledgments do not erase later pending operations; one rejection removes only that operation | R6, R7           |
| Real IndexedDB writes and reload    | No transmission before commit; unsent work survives reload and upgrades; stale responses cannot decrease revisions           | R2, R4           |
| Storage failure                     | Quota/open/write failures produce an honest delivery state rather than silently claiming durability                          | R2               |
| Durable Object delivery faults      | A committed event reaches each recipient after RPC failure or actor restart without duplicate projection effects             | R1, R5           |
| Account switching with delayed work | Requests from account A cannot write into account B's cache or database after cancellation or session replacement            | R3               |
| Two-tab lifecycle                   | Logout and upgrades release connections; signed-out UI does not wait forever on blocked deletion                             | R8               |
| Connection timing                   | Events between the HTTP snapshot and first socket registration are repaired; replay preserves write order                    | R2, R9           |
| Error protocol                      | Temporary failures stay pending; permanent failures follow explicit retry policy; ambiguous outcomes reuse the same `cid`    | R7               |
| Browser history and composer        | History can recover after reconnect; cancelling edit restores the draft; actions remain usable on narrow screens             | R10, UI behavior |
| New chat                            | Opening an empty DM makes it appear in the inbox without requiring a focus event or message                                  | R12              |
| Chaos lifecycle                     | `REDEPLOY=0` never rewrites source, and cleanup affects only resources owned by the current run                              | R11              |

Testing approach:

1. Use small deterministic tests for pure state rules. Specify expected state independently; do not calculate the expected result with the function under test.
2. Exercise the actual browser store and outbox in a browser with real IndexedDB. Controlled adapters are useful for scheduling faults, but do not prove IndexedDB transaction behavior.
3. Test Durable Object persistence, restart, and RPC behavior in the Cloudflare test runtime. Do not mistake an in-memory SQLite probe for platform validation.
4. Reuse production client code where possible in chaos tests rather than copying the algorithm.
5. Preserve the existing end-to-end chaos test for distinct delivery coverage. Make faults reproducible and record the failing sequence.
6. Do not run the current destructive cleanup/redeploy paths against a shared development session until R11 is addressed.

## Effect refactor

### Why this recommendation is small

Most findings are not missing retry combinators or missing dependency injection. They are incorrect state transitions:

- A maximum sequence is mistaken for a complete projection.
- A stale snapshot replaces a higher revision.
- Confirmed and pending state are mixed.
- Work is associated with whichever account is current when it completes.
- A persistence failure is treated as a successful write.

Effect can make execution and failure handling more explicit. It does not decide those domain rules.

The recommended first adoption changes the backend failure and delivery orchestration, not the architecture of the whole application. It still requires more than wrapping `Promise.allSettled()` in `Effect.all()`: durable delivery and typed wire errors must be designed first.

### Intended boundaries

```text
Browser
  React + TanStack Query + PartySocket + idb
  Pure reconciliation and an account-scoped lifecycle
       |
       | Valibot-validated protocol, including stable error codes
       v
UserDO
  Ordered frame handling
  Effect-backed RPC failure classification and bounded retry policy
       |
       v
ChatDO
  Synchronous, atomic event/state/delivery-intent persistence
       |
       v
Durable delivery drain
  Persisted pending work + platform wake-up/retry mechanism
  Effect-backed per-recipient attempts, concurrency limits, and reporting
```

Effect types remain internal to the backend. Wire frames remain plain validated data. Application imports must come from an installed package, not a reference checkout.

### First target: typed operation failures

Relevant code: `UserDO.handle()`, `ChatDO.write()`, `ServerFrame`, and the browser's `refused()` handler.

Proposed design:

1. Represent permanent domain failures explicitly, such as forbidden action, deleted target, and invalid input.
2. Distinguish temporary transport/storage failure and unknown commit outcome from domain rejection.
3. Map those categories to stable protocol error codes. Do not expose arbitrary exception messages as the protocol contract.
4. Use Effect's typed failure channel internally for recoverable failures. Report unexpected defects at the handler boundary.
5. Retry only eligible failures, with a bounded policy and the original `cid`.
6. Keep the existing per-user frame ordering. Retrying one frame must not silently allow later frames to overtake it.

Net benefit: one explicit error policy replaces catch-all exceptions and inconsistent browser handling. A plain tagged result union is still a reasonable alternative if Effect merely adds wrappers without removing policy duplication.

### Second target: durable delivery attempts

Relevant code: ChatDO fan-out and UserDO inbox projection.

Proposed design:

1. Commit the event, its materialized message change, and pending recipient delivery intents atomically.
2. Arrange a platform-backed wake-up mechanism that survives restart. For a SQLite-backed pending queue, use a Durable Object alarm with a retry/re-arm policy. Verify the crash windows in the real runtime.
3. Drain pending recipients with bounded concurrency. Catch/report each recipient's failure without discarding successful recipients or cancelling all remaining work.
4. Use Effect for short-lived attempts, selective retry, backoff, and structured failure reporting.
5. Clear each intent only after the recipient durably accepts it.
6. Leave undelivered work persisted when an attempt exhausts its retry budget. Resume it through the durable wake-up mechanism.
7. Make inbox projection safe under repeated and reordered attempts before enabling retries.

An Effect queue, fiber, or schedule in memory is not durable. Neither `waitUntil()` nor an Effect finalizer guarantees completion through process termination.

Keep sequence allocation and SQL mutation synchronous and atomic. Introducing `yield*` or `await` inside the critical section can invalidate the current ordering assumptions unless the transaction/concurrency design changes with it.

Net benefit: delivery attempt policy becomes easier to compose and test. The durable queue itself is correctness work, not complexity that Effect makes disappear.

### Optional later target: account-scoped client resources

Relevant code: `connect()`, `openStore()`, query functions, and signed-in route lifecycle.

First use an explicit account-scoped object holding the database handle, socket, cancellation controller, and generation/identity check.

Consider an Effect scope only if cleanup remains scattered after that change and there are enough shared asynchronous workflows to justify one client runtime. A scope would need to:

- Release socket listeners and database connections.
- Interrupt outstanding work on account replacement.
- Pass cancellation into actual browser operations.
- Prevent stale persistence even when the underlying operation cannot be interrupted.

This is not part of the initial backend pilot. Measure the browser bundle before adopting it.

### What not to refactor into Effect

- Pure `applyPatch()`, revision selection, cursor computation, and display projection.
- Every small Hono route or SQL helper.
- The component tree, TanStack Query cache, or PartySocket reconnect loop without a concrete replacement benefit.
- Valibot schemas solely to introduce a second schema system.
- The entire database layer or auth stack.

Avoid one service/layer per helper. Introduce services only at real boundaries that need substitution, such as delivery RPC, durable storage access, and time in orchestration tests.

### Adoption criteria

Keep the pilot only if:

- Temporary and permanent failures are explicit and exhaustively handled.
- Durable delivery survives an actor restart after event commit.
- Duplicate attempts and retries do not regress inbox state.
- Per-device send order is preserved.
- Error and retry policies become less duplicated, rather than merely acquiring wrappers.
- Cloudflare lifecycle behavior is tested and no detached background fiber is relied on for durability.
- The frontend receives no new Effect runtime in the first stage.

For any later frontend adoption, compare actual first-load gzip size and latency against the existing budget. The documented 155 KB baseline is not a fresh measurement from this review.

## Suggested implementation order

1. **Protect the existing workflow.** Address R11 so tests cannot overwrite source or delete another run's accounts. Add deterministic failing cases for R2, R3, R4, and R6.
2. **Repair client state and durability without Effect.** Commit outbox writes before transmission, isolate accounts, enforce revision rules, and derive optimistic state from confirmed state plus pending operations.
3. **Define the error protocol and pilot backend Effect.** Implement stable failure categories and one ordered retry policy. Keep the shared protocol independent of Effect.
4. **Repair inbox projection and durable fan-out.** Add persisted delivery intents and restart-safe retry. Use Effect for attempt orchestration, not persistence.
5. **Close lifecycle and UI gaps.** Initial-connect repair, multi-tab logout, history retry, new-chat inbox refresh, and the inactive image control.
6. **Validate and measure.** Run focused tests, typecheck, build, safe end-to-end chaos, and bundle measurement. Update claims only after the relevant behavior passes.

Each step should leave the app usable. Do not combine unrelated UI redesign or the next product phase with this reliability work.

## Source reference and subtree status

The linked article recommends providing library source to coding agents:

<https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive>

That is reference-management advice, not a reason to rewrite the application around Effect.

**No subtree was added.** During setup exploration, upstream references were read, but no clone, fetch into this repository, subtree commit, dependency install, or application refactor was performed.

If source is vendored later, select the exact release used by the application. Treat it as read-only reference material and exclude it from application tooling. Do not import application code from the vendored source directory.

Official documentation consulted:

- [Effect overview](https://effect.website/docs/v4/onboarding)
- [Expected failures and defects](https://effect.website/docs/v4/error-management/two-error-types)
- [Selective retries](https://effect.website/docs/v4/error-management/retrying)
- [Bounded concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency)
- [Resource management](https://effect.website/docs/v4/resource-management/introduction)

Verify APIs against the version chosen at implementation time. This document does not install or select a runtime dependency version.
