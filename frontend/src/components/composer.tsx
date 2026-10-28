import { useQueryClient } from '@tanstack/react-query'
import { MAX_BODY } from 'backend/protocol'
import { ArrowUpIcon, PlusIcon, SmileIcon } from 'lucide-react'
import { lazy, Suspense, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { sendMessage } from '@/lib/socket'

// The picker (Base UI Popover + frimousse) loads on first hover or focus of its button, not with the chat.
const loadEmojiPicker = () => import('@/components/emoji-picker')
const EmojiPicker = lazy(loadEmojiPicker)

export function Composer({ chatId, uid, placeholder }: { chatId: string; uid: string; placeholder: string }) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiLoaded, setEmojiLoaded] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const emojiButton = useRef<HTMLButtonElement>(null)

  const send = () => {
    const text = body.trim()
    if (!text) return
    sendMessage(queryClient, chatId, uid, text)
    setBody('')
  }

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
      className="shrink-0 px-4 pb-4 md:px-7 md:pb-6"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <div className="flex items-end gap-2.5">
        {/* ponytail: no upload yet; images arrive in phase 4 (direct-to-R2 uploads). */}
        <Button
          type="button"
          variant="sticker"
          size="icon"
          aria-label="Add image"
          className="mb-1.5 size-11 rounded-full shadow-[2px_2px_0_var(--color-ink)] hover:bg-sun"
        >
          <PlusIcon className="size-5" strokeWidth={2.75} />
        </Button>
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-[18px] border-2 border-ink bg-paper py-2 pr-2 pl-4 shadow-sticker">
          <textarea
            ref={input}
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            maxLength={MAX_BODY}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            className="[field-sizing:content] max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-base leading-[22px] outline-none placeholder:text-muted-foreground"
          />
          <button
            ref={emojiButton}
            type="button"
            aria-label="Emoji"
            aria-expanded={emojiOpen}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-ink aria-expanded:text-ink"
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
          <Button type="submit" variant="sun" size="icon" aria-label="Send" disabled={!body.trim()} className="size-11">
            <ArrowUpIcon className="size-[18px]" strokeWidth={2.75} />
          </Button>
        </div>
      </div>
    </form>
  )
}
