import { cn } from 'cn'

const R = 14
const AROUND = 2 * Math.PI * R

/** An upload's progress over a dimmed photo (Paper: "Images"). Spins while it hasn't started reporting. */
export function ProgressRing({ value, className }: { value: number | undefined; className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      aria-hidden="true"
      className={cn('relative size-11', value === undefined && 'motion-safe:animate-spin', className)}
    >
      <circle cx="18" cy="18" r={R} fill="none" stroke="rgb(255 255 255 / 35%)" strokeWidth="3.5" />
      <circle
        cx="18"
        cy="18"
        r={R}
        fill="none"
        stroke="#fff"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={`${AROUND * Math.max(value ?? 0.25, 0.04)} ${AROUND}`}
        transform="rotate(-90 18 18)"
      />
    </svg>
  )
}
