import { Avatar } from '@/components/avatar'
import { triggerClass, type ReadByProps } from '@/components/read-by'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatShort } from '@/lib/time'

/** The list behind `ReadBy`: who read it and when, and who hasn't yet. Loaded on first hover, focus or tap. */
export default function ReadByPopover({
  label,
  readers,
  waiting,
  open,
  onOpenChange,
}: ReadByProps & { label: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className={triggerClass}>{label}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-80 w-[280px] gap-2.5 overflow-y-auto rounded-2xl border-2 border-ink bg-paper px-4 py-3.5 text-ink shadow-[3px_3px_0_var(--color-ink)] ring-0"
      >
        <span className="text-[13px] font-bold">
          Read by {readers.length} of {readers.length + waiting.length}
        </span>
        {readers.map((r) => (
          <div key={r.id} className="flex items-center gap-2.5">
            <Avatar id={r.id} name={r.name} className="size-7 rounded-full text-xs" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.name}</span>
            <span className="text-xs text-muted-foreground">{formatShort(r.ts)}</span>
          </div>
        ))}
        {waiting.length > 0 && (
          <>
            <hr className="border-line" />
            <span className="text-[13px] font-bold">Not yet</span>
            <span className="text-sm text-muted-foreground">{waiting.map((w) => w.name).join(', ')}</span>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
