import type { Chat, InboxItem, Message } from 'backend/protocol'
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'

import type { LocalMessage } from './api'

// The device's copy of the user's data in IndexedDB. TanStack Query stays the store the UI reads; everything that
// changes it is written through to here, and the app reads it back on start so it renders before the network answers.

interface Schema extends DBSchema {
  /** Messages the server has stored, keyed by chat and `seq`. */
  messages: { key: [string, number]; value: Message }
  /** Messages written on this device that the server has not acked yet. Replayed on every connect. */
  outbox: { key: string; value: LocalMessage }
  inbox: { key: string; value: InboxItem }
  chats: { key: string; value: Chat }
}

let current: { uid: string; db: Promise<IDBPDatabase<Schema>> } | undefined

/** Opens the signed-in user's database. Each account gets its own, so switching accounts never mixes data. */
export function openStore(uid: string) {
  if (current?.uid === uid) return
  current = {
    uid,
    db: openDB<Schema>(`bubbles-${uid}`, 1, {
      upgrade(db) {
        db.createObjectStore('messages', { keyPath: ['chat', 'seq'] })
        db.createObjectStore('outbox', { keyPath: 'cid' })
        db.createObjectStore('inbox', { keyPath: 'chatId' })
        db.createObjectStore('chats', { keyPath: 'id' })
      },
    }),
  }
}

/** Removes everything this device holds for the user (on sign out). */
export async function deleteStore() {
  if (!current) return
  const { uid, db } = current
  current = undefined
  ;(await db).close()
  await deleteDB(`bubbles-${uid}`)
}

/** Runs against the database; the app keeps working (without a local copy) if IndexedDB is unavailable. */
async function use<T>(fallback: T, fn: (db: IDBPDatabase<Schema>) => Promise<T>) {
  try {
    if (!current) return fallback
    return await fn(await current.db)
  } catch (error) {
    console.error('Local store:', error)
    return fallback
  }
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

/** The newest messages held for a chat, plus its unsent ones, in display order. */
export const cachedMessages = (chat: string, limit: number) =>
  use<LocalMessage[]>([], async (db) => {
    const outbox = (await db.getAll('outbox')).filter((m) => m.chat === chat).sort((a, b) => (a.cid < b.cid ? -1 : 1))
    return [...(await acked(db, chat, limit)), ...outbox]
  })

/** A page of history before `before` from the local copy, so scrolling back works offline. */
export const cachedOlder = (chat: string, before: number, limit: number) =>
  use<Message[]>([], (db) => acked(db, chat, limit, before))

/**
 * Stores messages the server sent and clears them from the outbox. `dropBefore` deletes the chat's older copy when
 * gap repair had to jump to the latest page, so what's stored stays one unbroken run.
 */
export const saveMessages = (chat: string, messages: Message[], dropBefore?: number) =>
  use(undefined, async (db) => {
    const tx = db.transaction(['messages', 'outbox'], 'readwrite')
    const store = tx.objectStore('messages')
    await Promise.all([
      dropBefore !== undefined && store.delete(chatRange(chat, dropBefore)),
      ...messages.flatMap((m) => [store.put(m), tx.objectStore('outbox').delete(m.cid)]),
      tx.done,
    ])
  })

export const allOutbox = () =>
  use<LocalMessage[]>([], async (db) => (await db.getAll('outbox')).sort((a, b) => (a.cid < b.cid ? -1 : 1)))

export const saveOutbox = (message: LocalMessage) => use(undefined, (db) => db.put('outbox', message).then(() => {}))

/** The server stored an outbox message: move it to `messages` with its `seq`. */
export const ackOutbox = (cid: string, seq: number, ts: number) =>
  use(undefined, async (db) => {
    const tx = db.transaction(['messages', 'outbox'], 'readwrite')
    const pending = await tx.objectStore('outbox').get(cid)
    if (pending) {
      const { failed: _, ...message } = pending
      await Promise.all([tx.objectStore('messages').put({ ...message, seq, ts }), tx.objectStore('outbox').delete(cid)])
    }
    await tx.done
  })

export const failOutbox = (cid: string) =>
  use(undefined, async (db) => {
    const pending = await db.get('outbox', cid)
    if (pending) await db.put('outbox', { ...pending, failed: true })
  })

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
