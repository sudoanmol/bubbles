import type { Chat, InboxItem, Message } from 'backend/protocol'
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { useSyncExternalStore } from 'react'

import type { Pending } from './log'

// The device's copy of the user's data in IndexedDB. TanStack Query stays the store the UI reads; everything that
// changes it is written through to here, and the app reads it back on start so it renders before the network answers.

interface Schema extends DBSchema {
  /** Messages the server has stored, keyed by chat and `seq`. */
  messages: { key: [string, number]; value: Message }
  /** Frames written on this device that the server has not acked yet. Replayed on every connect. */
  outbox: { key: string; value: Pending }
  inbox: { key: string; value: InboxItem }
  chats: { key: string; value: Chat }
}

let current: { uid: string; db: Promise<IDBPDatabase<Schema>> } | undefined

/** Opens the signed-in user's database. Each account gets its own, so switching accounts never mixes data. */
export function openStore(uid: string) {
  if (current?.uid === uid) return
  current = {
    uid,
    // A new version starts the local copy over; it is only a cache of the server.
    db: openDB<Schema>(`bubbles-${uid}`, 2, {
      upgrade(db) {
        for (const name of db.objectStoreNames) db.deleteObjectStore(name)
        db.createObjectStore('messages', { keyPath: ['chat', 'seq'] })
        db.createObjectStore('outbox', { keyPath: 'cid' })
        db.createObjectStore('inbox', { keyPath: 'chatId' })
        db.createObjectStore('chats', { keyPath: 'id' })
      },
      // Another tab is deleting this database (sign out) or upgrading it: let go, so it isn't left waiting.
      blocking(_current, _blocked, event) {
        ;(event.target as IDBDatabase).close()
        if (current?.uid === uid) current = undefined
      },
    }),
  }
}

export const currentUid = () => current?.uid

/**
 * Throws if the open account is no longer `uid`. Work that awaits the network checks this before storing what it
 * got, so a response for one account never lands in the next one's database.
 */
export function checkAccount(uid: string | undefined) {
  if (current?.uid !== uid) throw new Error('Signed in as someone else')
}

/** Removes everything this device holds for the user (on sign out). */
export async function deleteStore() {
  if (!current) return
  const { uid, db } = current
  current = undefined
  ;(await db).close()
  await deleteDB(`bubbles-${uid}`)
}

/**
 * Runs against the database; the app keeps working (without a local copy) if IndexedDB is unavailable, and says so
 * (useStorageFailed), since unsent messages then live only in this tab.
 */
async function use<T>(fallback: T, fn: (db: IDBPDatabase<Schema>) => Promise<T>) {
  const account = current
  try {
    if (!account) return fallback
    return await fn(await account.db)
  } catch (error) {
    console.error('Local store:', error)
    // A database closed by sign-out or another tab isn't a broken browser.
    if (current === account && !failed) {
      failed = true
      listeners.forEach((l) => l())
    }
    return fallback
  }
}

let failed = false
const listeners = new Set<() => void>()

/** True once this browser failed to read or write the local copy (private mode, storage full, blocked). */
export function useStorageFailed() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => failed
  )
}

const chatRange = (chat: string, before = Infinity) => IDBKeyRange.bound([chat, -Infinity], [chat, before], false, true)

/** Up to `limit` acked messages before `before`, oldest first. */
async function acked(db: IDBPDatabase<Schema>, chat: string, limit: number, before?: number) {
  const out: Message[] = []
  let cursor = await db.transaction('messages').store.openCursor(chatRange(chat, before), 'prev')
  while (cursor && out.length < limit) {
    out.push(cursor.value)
    cursor = await cursor.continue()
  }
  return out.reverse()
}

/** The newest log entries held for a chat. */
export const cachedMessages = (chat: string, limit: number) => use<Message[]>([], (db) => acked(db, chat, limit))

/** A page of history before `before` from the local copy, so scrolling back works offline. */
export const cachedOlder = (chat: string, before: number, limit: number) =>
  use<Message[]>([], (db) => acked(db, chat, limit, before))

/**
 * Stores log entries the server sent and clears them from the outbox. A copy never replaces a newer one (higher
 * `rev`); patches are folded into their messages on read (`merge`). `dropBefore` deletes the chat's older copy when
 * gap repair had to jump to the latest page, so what's stored stays one unbroken run.
 */
export const saveMessages = (chat: string, messages: Message[], dropBefore?: number) =>
  use(undefined, async (db) => {
    const tx = db.transaction(['messages', 'outbox'], 'readwrite')
    const store = tx.objectStore('messages')
    const put = async (m: Message) => {
      const held = await store.get([chat, m.seq])
      if (!held || held.rev <= m.rev) await store.put(m)
    }
    await Promise.all([
      dropBefore !== undefined && store.delete(chatRange(chat, dropBefore)),
      ...messages.flatMap((m) => [put(m), tx.objectStore('outbox').delete(m.cid)]),
      tx.done,
    ])
  })

export const allOutbox = () =>
  use<Pending[]>([], async (db) => (await db.getAll('outbox')).sort((a, b) => (a.cid < b.cid ? -1 : 1)))

export const deleteOutbox = (cid: string) => use(undefined, (db) => db.delete('outbox', cid))

export const saveOutbox = (pending: Pending) => use(undefined, (db) => db.put('outbox', pending).then(() => {}))

export const cachedInbox = () =>
  use<InboxItem[]>([], async (db) => (await db.getAll('inbox')).sort((a, b) => b.updatedAt - a.updatedAt))

export const saveInbox = (items: InboxItem[]) =>
  use(undefined, async (db) => {
    const tx = db.transaction('inbox', 'readwrite')
    await Promise.all([tx.store.clear(), ...items.map((item) => tx.store.put(item)), tx.done])
  })

export const saveInboxItem = (item: InboxItem) => use(undefined, (db) => db.put('inbox', item).then(() => {}))

export const cachedChat = (id: string) => use<Chat | undefined>(undefined, (db) => db.get('chats', id))

export const saveChat = (chat: Chat) => use(undefined, (db) => db.put('chats', chat).then(() => {}))
