import { findLinks, type Link } from 'backend/protocol'
import { cn } from 'cn'
import type { MouseEvent, ReactNode } from 'react'

// A link opens in a new tab and lets go of focus, or coming back would find the bubble focused and its message
// actions showing.
const external = {
  target: '_blank',
  rel: 'noopener noreferrer',
  onClick: (e: MouseEvent<HTMLAnchorElement>) => e.currentTarget.blur(),
} as const

/** A message's text with every URL a link, underlined in the text's own color (Paper: "Links & previews"). */
export function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let at = 0

  for (const { start, end, href } of findLinks(text)) {
    parts.push(
      text.slice(at, start),
      <a
        key={start}
        href={href}
        {...external}
        className="font-medium underline decoration-[1.5px] underline-offset-[3px]"
      >
        {text.slice(start, end)}
      </a>
    )
    at = end
  }

  parts.push(text.slice(at))

  return parts
}

/** The card for a message's first link, at the top of its bubble. */
export function LinkCard({ link, mine }: { link: Link; mine: boolean }) {
  return (
    <a
      href={link.url}
      {...external}
      // As wide as the bubble, never wider: the bubble's own width (or its photos') sets it.
      className={cn('flex w-0 min-w-full flex-col overflow-hidden rounded-[14px]', mine ? 'bg-black/18' : 'bg-wash')}
    >
      {link.image && (
        <img
          src={link.image}
          alt=""
          loading="lazy"
          // The site sees no page of ours asking; a broken image just leaves the text.
          referrerPolicy="no-referrer"
          onError={(e) => e.currentTarget.remove()}
          className="h-[150px] w-full object-cover"
        />
      )}
      <span className="flex flex-col gap-[3px] px-3 pt-2.5 pb-3">
        <span className={cn('text-xs leading-4 font-semibold', mine ? 'text-white/80' : 'text-muted-foreground')}>
          {link.site}
        </span>
        <span className={cn('line-clamp-2 text-[15px] leading-5 font-bold', mine ? 'text-white' : 'text-ink')}>
          {link.title}
        </span>
        {link.description && (
          <span className={cn('line-clamp-2 text-sm leading-[18px]', mine ? 'text-white/80' : 'text-muted-foreground')}>
            {link.description}
          </span>
        )}
      </span>
    </a>
  )
}
