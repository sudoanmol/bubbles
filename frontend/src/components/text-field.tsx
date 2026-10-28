import { useId, type ComponentProps, type ReactNode } from 'react'

export function TextField({
  label,
  hint,
  leading,
  trailing,
  ...props
}: ComponentProps<'input'> & { label: string; hint?: ReactNode; leading?: ReactNode; trailing?: ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <div className="flex h-[52px] items-center gap-1.5 rounded-[14px] border-2 border-wash bg-wash px-4 transition-colors focus-within:border-ink focus-within:bg-paper">
        {leading && <span aria-hidden="true">{leading}</span>}
        <input
          id={id}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
          {...props}
        />
        {trailing}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}
