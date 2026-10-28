const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

const DAY = 86_400_000

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)

export const formatTime = (ts: number) => time.format(ts)

/** Inbox timestamps: 9:41 today, Tue this week, Oct 3 before that. */
export function formatShort(ts: number) {
  const days = (startOfDay(Date.now()) - startOfDay(ts)) / DAY
  if (days < 1) return time.format(ts)
  if (days < 7) return weekday.format(ts)
  return date.format(ts)
}

/** Day separators in a chat. */
export function formatDay(ts: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return longDate.format(ts)
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b)
