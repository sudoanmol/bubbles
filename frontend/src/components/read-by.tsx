import type { Profile } from 'backend/protocol'
import { lazy, Suspense, useState } from 'react'

import { firstName } from '@/lib/group-events'

// The popover (and Base UI's positioning) loads on first hover, focus or tap, so it stays out of the chat's first load.
const loadPopover = () => import('@/components/read-by-popover')
const ReadByPopover = lazy(loadPopover)

export type ReadByProps = { readers: (Profile & { ts: number })[]; waiting: Profile[] }
export const triggerClass = 'rounded hover:text-ink'

/**
 * Who read your newest message in a group: up to three names, then a count, or everyone. Tapping it lists them, with
 * when each last read the chat (Paper: "Groups: receipts, leaving, deleting").
 */
export function ReadBy({ readers, waiting }: ReadByProps) {
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const names = readers.map((r) => firstName(r.name))
  const label =
    waiting.length === 0
      ? 'Read by everyone'
      : `Read by ${names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : names.join(', ')}`
  const preload = () => void loadPopover()
  const trigger = (
    <button
      type="button"
      className={triggerClass}
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => {
        setLoaded(true)
        setOpen(true)
      }}
    >
      {label}
    </button>
  )
  if (!loaded) return trigger
  return (
    <Suspense fallback={trigger}>
      <ReadByPopover label={label} readers={readers} waiting={waiting} open={open} onOpenChange={setOpen} />
    </Suspense>
  )
}
