import { useSyncExternalStore } from 'react'

/** How long someone shows as typing after their last event; they send one every 3 s while they type. */
const LAPSE_MS = 5_000

/** Who is typing, by chat. Replaced, never changed in place, so React sees each change. */
let typing: Record<string, string[]> = {}
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

// Dev only: a hot update would load a second copy of this module that the socket doesn't feed. Reload instead.
import.meta.hot?.accept(() => location.reload())

function set(chat: string, uids: string[]) {
  const { [chat]: _, ...rest } = typing
  typing = uids.length ? { ...rest, [chat]: uids } : rest
  listeners.forEach((l) => l())
}

/** `uid` is typing in `chat`, for the next few seconds. */
export function startTyping(chat: string, uid: string) {
  const key = `${chat} ${uid}`
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => stopTyping(chat, uid), LAPSE_MS)
  )
  const now = typing[chat] ?? []

  if (!now.includes(uid)) set(chat, [...now, uid])
}

/** `uid` stopped typing in `chat`: the time lapsed, or their message arrived. */
export function stopTyping(chat: string, uid: string) {
  const key = `${chat} ${uid}`
  clearTimeout(timers.get(key))
  timers.delete(key)
  const now = typing[chat]

  if (now?.includes(uid))
    set(
      chat,
      now.filter((u) => u !== uid)
    )
}

/** Who is typing in each chat. */
export function useTyping() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => listeners.delete(l)
    },
    () => typing
  )
}
