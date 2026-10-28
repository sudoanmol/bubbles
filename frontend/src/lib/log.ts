// A chat's log as the client holds and shows it: pure rules, no storage or network, so they can be checked alone.
import { applyPatch, type ClientFrame, type Message, type Patch, type Text } from 'backend/protocol'

/** A message as shown: `seq` is null until the server acks it, and `failed` once it refused it. */
export type LocalMessage = Omit<Text, 'seq'> & { seq: number | null; failed?: boolean }

/** An outbox entry: a frame the server has not acked. A send keeps the message to show meanwhile. */
export type Pending = ((Extract<ClientFrame, { t: 'send' }> & { local: LocalMessage }) | Patch) & { failed?: boolean }

/**
 * A chat's messages as shown: the server's log with this device's unsent frames on top, sends as pending messages and
 * changes applied in write order. Derived on every render, so a live entry or an ack never wipes out a change still
 * pending. Patches stay in the log (they keep the cursor's run unbroken) but are already folded into their messages.
 */
export function withPending(chat: string, log: Message[], outbox: Pending[], uid: string): LocalMessage[] {
  const acked = new Set(log.map((m) => m.cid))
  let out: LocalMessage[] = log.filter((m) => m.kind === 'text')
  for (const p of outbox) {
    if (p.chat !== chat || acked.has(p.cid)) continue
    if (p.t === 'send') out = [...out, { ...p.local, failed: p.failed }]
    else
      out = out.map((m) => {
        if (m.seq !== p.seq) return m
        const next = applyPatch(m, p, uid, Date.now())
        return typeof next === 'string' ? m : { ...m, ...next }
      })
  }
  return out
}

/**
 * The end of the unbroken run of entries, starting from the oldest one held: what to sync after. Entries past a gap
 * (live ones that beat the repair) don't move it.
 */
export function cursor(messages: Message[]) {
  let hi: number | undefined
  for (const m of messages) {
    if (hi === undefined || m.seq === hi + 1) hi = m.seq
    else if (m.seq > hi + 1) break
  }
  return hi
}

/**
 * Merges log entries by `seq`. A copy of a message never replaces a newer one (higher `rev`). Every patch carries its
 * message's state after the change, so each message ends at the state of the newest entry about it, whichever
 * arrived first.
 */
export function merge(log: Message[], incoming: Message[]) {
  const bySeq = new Map(log.map((m) => [m.seq, m]))
  for (const m of incoming) {
    const held = bySeq.get(m.seq)
    if (!held || held.rev <= m.rev) bySeq.set(m.seq, m)
  }
  for (const p of bySeq.values()) {
    const target = p.kind === 'patch' ? bySeq.get(p.target) : undefined
    if (target && target.rev < p.seq) {
      const { body, reply, edited, deleted, reactions } = p
      bySeq.set(target.seq, { ...target, body, reply, edited, deleted, reactions, rev: p.seq })
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
