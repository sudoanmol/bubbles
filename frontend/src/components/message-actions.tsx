import { cn } from 'cn'
import { PencilIcon, ReplyIcon, SmilePlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import type { LocalMessage } from '@/lib/log'
import { formatTime } from '@/lib/time'

const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🔥']

const pill = 'flex items-center rounded-full border-2 border-ink bg-paper shadow-[2px_2px_0_var(--color-ink)]'
const action = 'flex size-8 items-center justify-center rounded-full transition-colors hover:bg-wash'

/**
 * The toolbar beside a bubble (Paper: "Message actions"). It shows while the message is hovered or has focus (a tap
 * on touch screens), with the message's time beyond it, and turns into the quick reactions when you pick react.
 */
export function MessageActions({
  message,
  mine,
  uid,
  editable,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  message: LocalMessage
  mine: boolean
  uid: string
  /** Yours and still inside the edit window. */
  editable: boolean
  onReact: (emoji: string | null) => void
  onReply: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [reacting, setReacting] = useState(false)
  const current = message.reactions[uid]

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      tabIndex={-1}
      className={cn(
        'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-2.5 transition-opacity duration-100',
        mine ? 'right-full mr-2 flex-row-reverse' : 'left-full ml-2',
        reacting
          ? 'opacity-100'
          : 'pointer-events-none opacity-0 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100'
      )}
      // Leaving the strip (focus moving outside it) closes it, as does Escape.
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setReacting(false)}
      onKeyDown={(e) => e.key === 'Escape' && setReacting(false)}
    >
      {reacting ? (
        <div className={cn(pill, '-rotate-1 gap-0.5 px-1.5 py-1')}>
          {QUICK.map((emoji, i) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              aria-pressed={current === emoji}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the strip opened from a button press; focus moves into it.
              autoFocus={i === 0}
              onClick={() => {
                onReact(current === emoji ? null : emoji)
                setReacting(false)
              }}
              className="flex size-9 items-center justify-center rounded-full text-[22px] transition-transform hover:scale-115 aria-pressed:bg-sun"
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <div className={cn(pill, 'gap-0.5 p-[3px]')}>
          <button type="button" aria-label="React" onClick={() => setReacting(true)} className={action}>
            <SmilePlusIcon className="size-[18px]" strokeWidth={2.25} />
          </button>
          <button type="button" aria-label="Reply" onClick={onReply} className={action}>
            <ReplyIcon className="size-[18px]" strokeWidth={2.25} />
          </button>
          {mine && (
            <>
              {editable && (
                <button type="button" aria-label="Edit" onClick={onEdit} className={action}>
                  <PencilIcon className="size-[17px]" strokeWidth={2.25} />
                </button>
              )}
              <button type="button" aria-label="Delete" onClick={onDelete} className={cn(action, 'text-danger')}>
                <Trash2Icon className="size-[17px]" strokeWidth={2.25} />
              </button>
            </>
          )}
        </div>
      )}
      {!reacting && (
        <span className="text-xs leading-4 font-medium whitespace-nowrap text-muted-foreground">
          {formatTime(message.ts)}
        </span>
      )}
    </div>
  )
}

/** Reaction chips on the bubble's bottom edge; yours is sun. Tapping one sets or takes back your reaction. */
export function Reactions({
  message,
  mine,
  uid,
  onReact,
}: {
  message: LocalMessage
  mine: boolean
  uid: string
  onReact: (emoji: string | null) => void
}) {
  const counts = new Map<string, number>()
  for (const emoji of Object.values(message.reactions)) counts.set(emoji, (counts.get(emoji) ?? 0) + 1)
  if (!counts.size) return null
  const current = message.reactions[uid]
  return (
    <div className={cn('relative -mt-2.5 flex gap-1.5', mine ? 'mr-3 self-end' : 'ml-3 self-start')}>
      {[...counts].map(([emoji, n]) => (
        <button
          key={emoji}
          type="button"
          aria-label={`${emoji} ${n}`}
          aria-pressed={current === emoji}
          onClick={() => onReact(current === emoji ? null : emoji)}
          className="flex items-center gap-[5px] rounded-full border-[1.5px] border-ink bg-paper py-0.5 pr-[7px] pl-[7px] text-[15px] leading-5 aria-pressed:bg-sun"
        >
          {emoji}
          {n > 1 && <span className="text-xs leading-4 font-bold">{n}</span>}
        </button>
      ))}
    </div>
  )
}
