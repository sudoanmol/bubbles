import { useEffect, useState } from 'react'

/** The time, updated every `ms`, for anything shown relative to now (edit windows, "active 5m ago"). */
export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}
