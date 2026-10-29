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
      <div className="flex h-[52px] items-center gap-1.5 rounded-[14px] border-2 border-wash bg-wash px-4 transition-colors focus-within:border-ink focus-within:bg-paper has-aria-invalid:border-danger">
        {leading && <span aria-hidden="true">{leading}</span>}
        <input
          id={id}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          {...props}
        />
        {trailing}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/** Whether a username is free, beside the field: a mint "available" or a red "taken". */
export function Availability({
  checking,
  valid,
  available,
}: {
  checking: boolean
  valid: boolean
  available?: boolean
}) {
  if (checking || !valid) return null

  return available ? (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-mint/15 px-2.5 py-1.5 text-[13px] font-semibold text-mint">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      available
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-danger/10 px-2.5 py-1.5 text-[13px] font-semibold text-danger">
      taken
    </span>
  )
}
