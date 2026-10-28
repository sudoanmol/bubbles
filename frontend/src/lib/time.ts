import { differenceInCalendarDays, isToday, isYesterday } from 'date-fns'

// Formatting stays on Intl: it follows the user's locale and costs nothing, while date-fns' `format` pulls in
// a locale and every formatter (~6 KB gzip). date-fns handles the calendar math (DST-safe day differences).
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const longWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

export const formatTime = (ts: number) => time.format(ts)

/** Inbox timestamps: 9:41 today, Tue this week, Oct 3 before that. */
export function formatShort(ts: number) {
  const days = differenceInCalendarDays(Date.now(), ts)
  if (days < 1) return time.format(ts)
  if (days < 7) return weekday.format(ts)
  return date.format(ts)
}

/** Time separators in a chat: Today, Yesterday, Tuesday this week, Oct 3 before that. */
export function formatDay(ts: number) {
  if (isToday(ts)) return 'Today'
  if (isYesterday(ts)) return 'Yesterday'
  return differenceInCalendarDays(Date.now(), ts) < 7 ? longWeekday.format(ts) : date.format(ts)
}
