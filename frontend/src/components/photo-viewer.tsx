import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import type { Image } from 'backend/protocol'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { Avatar } from '@/components/avatar'
import { formatDay, formatTime } from '@/lib/time'
import { imageSrc } from '@/lib/upload'

const round = 'flex size-10 shrink-0 items-center justify-center rounded-full bg-white/12 text-white hover:bg-white/20'

const sticker =
  'flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white text-black shadow-sticker-sun disabled:invisible'

/**
 * A message's photos full screen (Paper: "Images"). Esc or a tap outside the photo closes it; the arrows, arrow keys
 * and a swipe page through them. Loaded the first time a photo is opened.
 */
export default function PhotoViewer({
  images,
  index,
  onIndex,
  sender,
  ts,
  onClose,
}: {
  images: Image[]
  index: number
  onIndex: (index: number) => void
  sender: { id: string; name: string; image?: string | null }
  ts: number
  onClose: () => void
}) {
  const image = images[index]
  const go = (step: number) => onIndex(Math.min(Math.max(index + step, 0), images.length - 1))
  const swipe = useRef(0)
  // Focus goes back to the photo on close only if it was opened from the keyboard. After a click, a focused photo
  // would keep its bubble's message actions showing.
  const [fromKeyboard] = useState(() => document.activeElement?.matches(':focus-visible') ?? false)

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-[#121212f0]" />
        {/* Clicks fall through the popup's empty space to the backdrop, so a tap around the photo closes it. */}
        <DialogPrimitive.Popup
          aria-label="Photo"
          finalFocus={fromKeyboard}
          className="pointer-events-none fixed inset-0 z-50 flex flex-col outline-none *:pointer-events-auto"
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') go(-1)

            if (e.key === 'ArrowRight') go(1)
          }}
          onTouchStart={(e) => (swipe.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            const dx = e.changedTouches[0].clientX - swipe.current

            if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1)
          }}
        >
          <div className="flex items-center gap-3 px-5 py-4 *:pointer-events-auto">
            <Avatar id={sender.id} image={sender.image} className="size-9" />
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogPrimitive.Title className="truncate text-[15px] leading-[18px] font-semibold text-white">
                {sender.name}
              </DialogPrimitive.Title>
              <span className="text-[13px] leading-4 text-white/65">
                {formatDay(ts)} {formatTime(ts)}
                {images.length > 1 && ` · ${index + 1} of ${images.length}`}
              </span>
            </div>
            <a href={imageSrc(image.key)} download aria-label="Download" className={round}>
              <DownloadIcon className="size-[18px]" strokeWidth={2.5} />
            </a>
            <DialogPrimitive.Close aria-label="Close" className={round}>
              <XIcon className="size-[18px]" strokeWidth={2.5} />
            </DialogPrimitive.Close>
          </div>
          <div className="pointer-events-none! flex min-h-0 flex-1 items-center justify-between gap-3 px-5 pb-7 *:pointer-events-auto">
            <button
              type="button"
              aria-label="Previous photo"
              disabled={index === 0}
              onClick={() => go(-1)}
              className={sticker}
            >
              <ChevronLeftIcon className="size-[18px]" strokeWidth={2.75} />
            </button>
            <img
              key={image.key}
              src={imageSrc(image.key)}
              alt=""
              width={image.w}
              height={image.h}
              className="h-auto max-h-full max-w-full min-w-0 rounded-[14px] object-contain"
            />
            <button
              type="button"
              aria-label="Next photo"
              disabled={index === images.length - 1}
              onClick={() => go(1)}
              className={sticker}
            >
              <ChevronRightIcon className="size-[18px]" strokeWidth={2.75} />
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
