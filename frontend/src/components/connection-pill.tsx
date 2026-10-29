import { cn } from 'cn'
import { CircleAlertIcon, WifiOffIcon } from 'lucide-react'

import { useConnection } from '@/lib/socket'
import { useStorageFailed } from '@/lib/store'

/** Sits above the composer while the socket is down or this browser can't save (Paper: "Offline & delivery"). */
export function ConnectionPill() {
  const connection = useConnection()
  const storageFailed = useStorageFailed()

  // The connection comes first: offline or reconnecting is what explains a message not going out right now.
  if (connection === 'online' && storageFailed)
    return (
      <div className="pointer-events-none absolute inset-x-0 -top-3 flex -translate-y-full justify-center px-4">
        <output className="flex animate-in items-center gap-2 rounded-full border-2 border-ink bg-paper py-[7px] pr-4 pl-3 shadow-[2px_2px_0_var(--color-ink)] duration-200 fade-in slide-in-from-bottom-2">
          <CircleAlertIcon className="size-4 shrink-0 text-danger" strokeWidth={2.5} aria-hidden="true" />
          <span className="text-sm leading-[18px] font-semibold">
            This browser can't save messages. Keep the tab open until they send.
          </span>
        </output>
      </div>
    )

  if (connection === 'online') return null
  const offline = connection === 'offline'

  return (
    <div className="pointer-events-none absolute inset-x-0 -top-3 flex -translate-y-full justify-center px-4">
      <output
        className={cn(
          'flex animate-in items-center rounded-full border-2 border-ink py-[7px] pr-4 shadow-[2px_2px_0_var(--color-ink)] duration-200 fade-in slide-in-from-bottom-2',
          // Reconnecting fades in after a second, so a quick blip (or the first connect) never flashes it.
          offline
            ? '-rotate-1 gap-2 bg-sun pl-3'
            : 'gap-2.5 bg-paper pl-3.5 [animation-delay:1s] [animation-fill-mode:backwards]'
        )}
      >
        {offline ? (
          <>
            <WifiOffIcon className="size-4 shrink-0" strokeWidth={2.25} aria-hidden="true" />
            <span className="text-sm leading-[18px] font-semibold">
              You're offline. Messages will send when you're back.
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="size-1.5 animate-bounce rounded-full bg-gum" />
              <span className="size-1.5 animate-bounce rounded-full bg-sun [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-cobalt [animation-delay:300ms]" />
            </span>
            <span className="text-sm leading-[18px] font-semibold">Reconnecting…</span>
          </>
        )}
      </output>
    </div>
  )
}
