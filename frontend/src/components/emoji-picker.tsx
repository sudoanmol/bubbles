import { Popover } from '@base-ui/react/popover'
import { EmojiPicker as Picker } from 'frimousse'
import { SearchIcon } from 'lucide-react'
import type { RefObject } from 'react'

/** Emoji popover anchored to the composer's emoji button. Loaded on demand by the composer. */
export default function EmojiPicker({
  open,
  onOpenChange,
  anchor,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RefObject<HTMLButtonElement | null>
  onPick: (emoji: string) => void
}) {
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, { event }) => {
        // Presses on the emoji button are its own toggle, not an outside press.
        if (!next && event.target instanceof Node && anchor.current?.contains(event.target)) return
        onOpenChange(next)
      }}
    >
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={16} alignOffset={-8}>
          <Popover.Popup
            finalFocus={false}
            className="origin-(--transform-origin) rounded-[22px] border-2 border-ink bg-paper shadow-[5px_5px_0_var(--color-ink)] transition-[scale,opacity] duration-150 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <Picker.Root
              columns={9}
              onEmojiSelect={({ emoji }) => onPick(emoji)}
              className="isolate flex h-[400px] w-[372px] flex-col"
            >
              <div className="flex items-center gap-2 p-3 pb-2">
                <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-wash px-3">
                  <SearchIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2.5} aria-hidden="true" />
                  <Picker.Search
                    aria-label="Search emoji"
                    placeholder="Search emoji"
                    className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <Picker.SkinToneSelector
                  aria-label="Change skin tone"
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl text-xl hover:bg-wash"
                />
              </div>
              <Picker.Viewport className="relative flex-1 outline-none">
                <Picker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </Picker.Loading>
                <Picker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No emoji found.
                </Picker.Empty>
                <Picker.List
                  className="pb-2 select-none"
                  components={{
                    CategoryHeader: ({ category, ...props }) => (
                      <div
                        className="bg-paper/95 px-3.5 pt-3 pb-1.5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase backdrop-blur-sm"
                        {...props}
                      >
                        {category.label}
                      </div>
                    ),
                    Row: ({ children, ...props }) => (
                      <div className="scroll-my-1.5 px-2" {...props}>
                        {children}
                      </div>
                    ),
                    Emoji: ({ emoji, ...props }) => (
                      <button
                        className="flex size-9 items-center justify-center rounded-[10px] text-[22px] transition-transform duration-100 data-active:scale-110 data-active:bg-sun/60"
                        {...props}
                      >
                        {emoji.emoji}
                      </button>
                    ),
                  }}
                />
              </Picker.Viewport>
              {/* Preview of the hovered emoji, like Slack and Discord. */}
              <div className="flex h-14 shrink-0 items-center gap-2.5 border-t border-line px-3.5">
                <Picker.ActiveEmoji>
                  {({ emoji }) =>
                    emoji ? (
                      <>
                        <span className="text-[28px] leading-none">{emoji.emoji}</span>
                        <span className="truncate text-sm font-semibold">{emoji.label}</span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">Pick an emoji…</span>
                    )
                  }
                </Picker.ActiveEmoji>
              </div>
            </Picker.Root>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
