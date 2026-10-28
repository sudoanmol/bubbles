import { useQueryClient } from '@tanstack/react-query'
import { MAX_BODY } from 'backend/protocol'
import { cn } from 'cn'
import { ArrowUpIcon, PlusIcon, SmileIcon } from 'lucide-react'
import { lazy, Suspense, useRef, useState } from 'react'

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
      <div className="flex items-end gap-3">
        {/* ponytail: no upload yet; images arrive in phase 4 (direct-to-R2 uploads). */}
        <button
          type="button"
          aria-label="Add image"
          className="relative -top-1 flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-paper shadow-[2px_2px_0_var(--color-ink)] transition-[translate,box-shadow,background-color] duration-100 hover:bg-sun active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
        >
          <PlusIcon className="size-5" strokeWidth={2.75} />
        </button>
        <div className="flex min-h-14 min-w-0 flex-1 items-end gap-1 rounded-[28px] border-2 border-ink bg-paper py-1.5 pr-1.5 pl-5 shadow-sticker">
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
            disabled={!body.trim()}
            className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-sun text-ink transition-colors disabled:cursor-default disabled:border-transparent disabled:bg-wash disabled:text-[#b5b5b5]"
          >
            <ArrowUpIcon className="size-[18px]" strokeWidth={2.75} />
          </button>
        </div>
      </div>
    </form>
  )
}
