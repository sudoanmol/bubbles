// Photos: uploaded as picked, at full quality, to R2 through the API (backend/src/routes/media.ts) as soon as they're
// picked. A message with photos waits in the outbox until they're up (socket.ts).
import { MAX_IMAGE_BYTES, mediaUrl, type Image } from 'backend/protocol'
import { useSyncExternalStore } from 'react'
import { ulid } from 'ulid'

/** A photo ready to upload; `key` is where it will live, so the message can name it before it's up. */
export type Upload = Image & { blob: Blob }

/** A refusal from the server (too big, not a photo), as opposed to a network failure worth retrying. */
export class UploadRefused extends Error {}

/** Checks a picked photo and reads its size. The file itself uploads untouched, at full quality. */
export async function prepare(file: File, uid: string): Promise<Upload> {
  if (file.size > MAX_IMAGE_BYTES) throw new UploadRefused('Photos can be up to 10 MB')

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new UploadRefused("That file isn't a photo")
  })

  const { width: w, height: h } = bitmap

  bitmap.close()
  const upload = { key: `${uid}/${ulid()}`, w, h, blob: file }
  keep(upload)

  return upload
}

// This device's own photos show from memory, so sending one never waits on (or refetches from) the server.
const local = new Map<string, string>()

/** Shows a photo from its file until the page closes. */
export function keep({ key, blob }: Upload) {
  if (!local.has(key)) local.set(key, URL.createObjectURL(blob))
}

export const imageSrc = (key: string) => local.get(key) ?? mediaUrl(key)

const progress = new Map<string, number>()
const uploading = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function setProgress(key: string, value: number) {
  progress.set(key, value)
  listeners.forEach((l) => l())
}

/** How far the uploads of these photos are together, 0 to 1; undefined while one isn't uploading in this tab. */
export function useProgress(keys: string[]) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => listeners.delete(l)
    },
    () => {
      const each = keys.map((k) => progress.get(k))

      return each.every((p) => p !== undefined) ? each.reduce((a, b) => a + b, 0) / each.length : undefined
    }
  )
}

/**
 * Uploads a photo once: asking again while it's on its way (Send right after picking) waits for the same upload. A
 * failed one can be tried again. Uploading a key twice (after a reload) just stores the same bytes again.
 */
export function upload(u: Upload) {
  const started = uploading.get(u.key)

  if (started) return started

  const done = put(u)

  uploading.set(u.key, done)
  done.catch(() => {
    uploading.delete(u.key)
    progress.delete(u.key)
  })

  return done
}

// XHR rather than fetch: fetch can't report upload progress.
function put(u: Upload) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', mediaUrl(u.key.split('/')[1]))
    xhr.setRequestHeader('content-type', u.blob.type)
    xhr.upload.onprogress = (e) => setProgress(u.key, e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status < 300) return resolve(setProgress(u.key, 1))

      const message = (() => {
        try {
          // SAFETY: the API's error bodies are `{ message }` (backend/src/index.ts, onError).
          return (JSON.parse(xhr.responseText) as { message?: string }).message
        } catch {
          return undefined
        }
      })()

      reject(xhr.status < 500 ? new UploadRefused(message ?? 'Upload refused') : new Error(message ?? 'Upload failed'))
    }

    xhr.onerror = () => reject(new Error('Upload failed'))
    setProgress(u.key, 0)
    xhr.send(u.blob)
  })
}
