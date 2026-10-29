import type { Image } from 'backend/protocol'
import { cn } from 'cn'

import { ProgressRing } from '@/components/progress-ring'
import { imageSrc, useProgress } from '@/lib/upload'

/** Most photos shown in a message; the last one shown says how many more there are. */
const SHOWN = 4

/**
 * A message's photos (Paper: "Images"): one at its own shape, two side by side, more in rows of two. Unsent ones are
 * dimmed under their upload's progress; tapping one opens it full screen.
 */
export function Photos({
  images,
  sending,
  failed,
  className,
  onOpen,
}: {
  images: Image[]
  sending: boolean
  failed?: boolean
  className?: string
  onOpen: (index: number) => void
}) {
  const shown = images.slice(0, SHOWN)
  const more = images.length - shown.length

  return (
    <div
      className={cn(
        'relative grid w-[300px] max-w-full grid-cols-2 gap-1 overflow-hidden',
        failed && 'opacity-55',
        className
      )}
    >
      {shown.map((image, i) => (
        <button
          key={image.key}
          type="button"
          aria-label={`Open photo ${i + 1} of ${images.length}`}
          onClick={() => onOpen(i)}
          className={cn(
            'relative overflow-hidden rounded-[6px] bg-wash',
            // Alone, or last of an odd count: the whole row.
            (shown.length === 1 || (i === shown.length - 1 && i % 2 === 0)) && 'col-span-2',
            shown.length === 2 ? 'h-[200px]' : shown.length > 2 && 'h-[148px]'
          )}
        >
          <img
            src={imageSrc(image.key)}
            alt=""
            loading="lazy"
            decoding="async"
            width={image.w}
            height={image.h}
            style={shown.length === 1 ? { aspectRatio: `${image.w} / ${image.h}` } : undefined}
            className={cn('size-full object-cover', shown.length === 1 && 'h-auto max-h-[400px] min-h-[120px]')}
          />
          {more > 0 && i === SHOWN - 1 && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 font-display text-[32px] leading-9 font-extrabold tracking-[-0.03em] text-white">
              +{more}
            </span>
          )}
        </button>
      ))}
      {sending && <Uploading keys={images.map((i) => i.key)} />}
    </div>
  )
}

function Uploading({ keys }: { keys: string[] }) {
  const progress = useProgress(keys)

  return (
    <span className="absolute inset-0 flex items-center justify-center bg-black/35">
      <ProgressRing value={progress} />
    </span>
  )
}
