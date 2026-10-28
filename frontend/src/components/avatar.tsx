import { cn } from 'cn'

const colors = ['bg-gum text-ink', 'bg-cobalt text-paper', 'bg-sun text-ink', 'bg-mint text-paper']

/** Initials on a color picked from the user's id, so a person keeps their color everywhere. */
export function Avatar({ id, name, className }: { id: string; name: string; className?: string }) {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-bubble font-display text-lg font-extrabold',
        colors[Math.abs(hash) % colors.length],
        className
      )}
    >
      {initials}
    </div>
  )
}
