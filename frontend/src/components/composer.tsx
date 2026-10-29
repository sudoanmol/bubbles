import { useQueryClient } from '@tanstack/react-query'
import { canEdit, MAX_BODY, MAX_IMAGES, previewText } from 'backend/protocol'
import { cn } from 'cn'
import { ArrowUpIcon, PencilIcon, PlusIcon, ReplyIcon, SmileIcon, XIcon } from 'lucide-react'
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react'

import { ConnectionPill } from '@/components/connection-pill'
import { ProgressRing } from '@/components/progress-ring'
import { messagesQuery, outboxQuery } from '@/lib/api'
import { withPending, type LocalMessage } from '@/lib/log'
import { patchMessage, sendMessage, sendTyping } from '@/lib/socket'
import { imageSrc, prepare, upload, UploadRefused, useProgress, type Upload } from '@/lib/upload'

// The picker (Base UI Popover + frimousse) loads on first hover or focus of its button, not with the chat.
const loadEmojiPicker = () => import('@/components/emoji-picker')
const EmojiPicker = lazy(loadEmojiPicker)

/** Replying to a message, or editing one of yours. */
export type ComposerMode = { t: 'reply' | 'edit'; message: LocalMessage } | null

export function Composer({
  chatId,
  uid,
  placeholder,
  names,
  mode,
  onMode,
}: {
  chatId: string
  uid: string
  placeholder: string
  names: Map<string, string>
  mode: ComposerMode
  onMode: (mode: ComposerMode) => void
}) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiLoaded, setEmojiLoaded] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const emojiButton = useRef<HTMLButtonElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [photos, setPhotos] = useState<Upload[]>([])
  const [photoError, setPhotoError] = useState<string | null>(null)

  /**
   * Adds photos (from +, paste or drop), up to MAX_IMAGES.
   * ponytail: a photo removed after it uploaded stays in R2; sweep unreferenced keys if storage costs matter.
   */
  const addPhotos = (files: File[]) => {
    setPhotoError(null)

    for (const file of files.filter((f) => f.type.startsWith('image/')).slice(0, MAX_IMAGES - photos.length))
      prepare(file, uid)
        .then((photo) => setPhotos((held) => (held.length < MAX_IMAGES ? [...held, photo] : held)))
        .catch((error) => setPhotoError(error instanceof Error ? error.message : 'Could not add that photo'))
  }

  // Photos upload as soon as they're in the tray, so Send doesn't wait. Asking again for one already uploading or up
  // just gets that upload, so this runs on every change; a failed one is tried again then, or when the message is sent.
  useEffect(() => {
    for (const photo of photos)
      upload(photo).catch((error) => {
        if (!(error instanceof UploadRefused)) return
        setPhotoError(error.message)
        setPhotos((held) => held.filter((p) => p.key !== photo.key))
      })
  }, [photos])

  // Photos dropped anywhere on the chat land here, except while editing, which has no tray.
  const onDrop = useEffectEvent((files: File[]) => {
    if (mode?.t !== 'edit') addPhotos(files)
  })

  useEffect(() => {
    const over = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault()

    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      onDrop([...e.dataTransfer.files])
    }

    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)

    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Ready to type when a chat opens. Not on touch screens, where focusing would pop the keyboard over the chat.
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus()
  }, [])

  // Entering edit puts the message in the field and keeps your draft for after; leaving edit brings the draft back.
  const [entered, setEntered] = useState<ComposerMode>(null)

  if (mode !== entered) {
    setEntered(mode)

    if (mode?.t === 'edit') {
      if (entered?.t !== 'edit') setDraft(body)
      setBody(mode.message.body)
    } else if (entered?.t === 'edit') setBody(draft)
  }

  useEffect(() => {
    if (mode) input.current?.focus()
  }, [mode])

  const send = () => {
    const text = body.trim()

    if (mode?.t === 'edit') {
      if (text && text !== mode.message.body) patchMessage(queryClient, uid, mode.message, { t: 'edit', body: text })
      onMode(null)

      return
    }

    if (!text && !photos.length) return
    sendMessage(queryClient, chatId, uid, text, mode?.message, photos)
    setBody('')
    setPhotos([])
    setPhotoError(null)
    onMode(null)
  }

  const editing = mode?.t === 'edit'
  const ready = editing ? !!body.trim() : !!body.trim() || photos.length > 0

  /** Puts the emoji where the caret was, then hands focus back to the input. */
  const insert = (emoji: string) => {
    const start = input.current?.selectionStart ?? body.length
    const end = input.current?.selectionEnd ?? body.length
    setBody(body.slice(0, start) + emoji + body.slice(end))
    setEmojiOpen(false)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(start + emoji.length, start + emoji.length)
    })
  }

  return (
    <form
      className="relative shrink-0 px-4 pb-4 md:px-7 md:pb-6"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <ConnectionPill />
      {mode && (
        <div
          className={cn(
            'mb-2 ml-[60px] flex items-center gap-3 rounded-[18px] border-2 border-ink py-2 pr-2 pl-3.5 shadow-[2px_2px_0_var(--color-ink)]',
            mode.t === 'edit' ? 'bg-sun text-black' : 'bg-paper'
          )}
        >
          {mode.t === 'edit' ? (
            <PencilIcon className="size-[17px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
          ) : (
            <ReplyIcon className="size-[18px] shrink-0 text-cobalt" strokeWidth={2.5} aria-hidden="true" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[13px] leading-4 font-bold">
              {mode.t === 'edit'
                ? 'Editing message'
                : mode.message.sender === uid
                  ? 'Replying to yourself'
                  : `Replying to ${names.get(mode.message.sender) ?? 'them'}`}
            </span>
            <span
              className={cn(
                'truncate text-sm leading-[18px]',
                mode.t === 'edit' ? 'text-black/70' : 'text-muted-foreground'
              )}
            >
              {previewText(mode.message)}
            </span>
          </div>
          <button
            type="button"
            aria-label={mode.t === 'edit' ? 'Cancel editing' : 'Cancel reply'}
            onClick={() => onMode(null)}
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full',
              mode.t === 'edit' ? 'bg-paper' : 'bg-wash'
            )}
          >
            <XIcon className="size-4" strokeWidth={2.5} />
          </button>
        </div>
      )}
      {/* Paper: "Images", the tray of picked photos above the field. */}
      {!editing && (photos.length > 0 || photoError) && (
        <div className="mb-2 ml-[60px] flex w-fit max-w-[calc(100%-60px)] flex-wrap items-center gap-2.5 rounded-[18px] border-2 border-ink bg-paper p-2.5 shadow-[2px_2px_0_var(--color-ink)]">
          {photos.map((photo) => (
            <Thumb
              key={photo.key}
              photo={photo}
              onRemove={() => setPhotos((held) => held.filter((p) => p !== photo))}
            />
          ))}
          {photos.length > 0 && photos.length < MAX_IMAGES && (
            <button
              type="button"
              aria-label="Add more photos"
              onClick={() => filePicker.current?.click()}
              className="flex size-[72px] shrink-0 items-center justify-center rounded-[14px] border-2 border-dashed border-[#cfcfcf] text-muted-foreground transition-colors hover:border-ink hover:text-ink"
            >
              <PlusIcon className="size-5" strokeWidth={2.75} />
            </button>
          )}
          {photoError && <span className="px-1 text-sm font-semibold text-danger">{photoError}</span>}
        </div>
      )}
      <input
        ref={filePicker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addPhotos([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div className="flex items-end gap-3">
        <button
          type="button"
          aria-label="Add photos"
          disabled={editing || photos.length >= MAX_IMAGES}
          onClick={() => filePicker.current?.click()}
          className="relative -top-1 flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-paper text-ink shadow-[2px_2px_0_var(--color-ink)] transition-colors hover:bg-sun hover:text-black disabled:border-dashed disabled:border-[#cfcfcf] disabled:text-[#b5b5b5] disabled:shadow-none disabled:hover:bg-paper"
        >
          <PlusIcon className="size-5" strokeWidth={2.75} />
        </button>
        <div className="flex min-h-14 min-w-0 flex-1 items-end gap-1 rounded-[28px] border-2 border-ink bg-paper py-1.5 pr-1.5 pl-5 shadow-sticker">
          <textarea
            ref={input}
            aria-label={placeholder}
            placeholder={photos.length && !editing ? 'Add a caption' : placeholder}
            rows={1}
            maxLength={MAX_BODY}
            value={body}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))

              if (!files.length || editing) return
              e.preventDefault()
              addPhotos(files)
            }}
            onChange={(e) => {
              setBody(e.target.value)

              if (e.target.value.trim() && mode?.t !== 'edit') sendTyping(chatId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }

              if (e.key === 'Escape' && mode) onMode(null)

              // Up in an empty field edits your last message, as in Slack and Discord.
              if (e.key === 'ArrowUp' && !body && !mode) {
                const last = withPending(
                  chatId,
                  queryClient.getQueryData(messagesQuery(chatId).queryKey) ?? [],
                  queryClient.getQueryData(outboxQuery.queryKey) ?? [],
                  uid
                ).findLast((m) => m.kind === 'text' && m.sender === uid && m.seq !== null && !m.deleted)

                if (last && canEdit(last, uid, Date.now())) {
                  e.preventDefault()
                  onMode({ t: 'edit', message: last })
                }
              }
            }}
            className="[field-sizing:content] max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-base leading-[22px] outline-none placeholder:text-muted-foreground"
          />
          <button
            ref={emojiButton}
            type="button"
            aria-label="Emoji"
            aria-expanded={emojiOpen}
            className={cn(
              'mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full transition-colors hover:text-ink aria-expanded:bg-wash aria-expanded:text-ink',
              body ? 'text-ink' : 'text-muted-foreground'
            )}
            onPointerEnter={() => void loadEmojiPicker()}
            onFocus={() => void loadEmojiPicker()}
            onClick={() => {
              setEmojiLoaded(true)
              setEmojiOpen(!emojiOpen)
            }}
          >
            <SmileIcon className="size-[22px]" strokeWidth={2} />
          </button>
          {emojiLoaded && (
            <Suspense>
              <EmojiPicker open={emojiOpen} onOpenChange={setEmojiOpen} anchor={emojiButton} onPick={insert} />
            </Suspense>
          )}
          {/* Lights up (sun) only when there is something to send. */}
          <button
            type="submit"
            aria-label="Send"
            disabled={!ready}
            className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-sun text-black transition-colors disabled:cursor-default disabled:border-transparent disabled:bg-wash disabled:text-[#b5b5b5]"
          >
            <ArrowUpIcon className="size-[18px]" strokeWidth={2.75} />
          </button>
        </div>
      </div>
    </form>
  )
}

/** A picked photo in the tray: dimmed under its upload's progress until it's up. */
function Thumb({ photo, onRemove }: { photo: Upload; onRemove: () => void }) {
  const progress = useProgress([photo.key])

  return (
    <div className="relative size-[72px] shrink-0">
      <img src={imageSrc(photo.key)} alt="" className="size-full rounded-[14px] object-cover" />
      {progress !== 1 && (
        <span className="absolute inset-0 flex items-center justify-center rounded-[14px] bg-black/35">
          <ProgressRing value={progress} className="size-[30px]" />
        </span>
      )}
      <button
        type="button"
        aria-label="Remove photo"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-[22px] items-center justify-center rounded-full border-2 border-paper bg-ink text-paper"
      >
        <XIcon className="size-2.5" strokeWidth={4} />
      </button>
    </div>
  )
}
