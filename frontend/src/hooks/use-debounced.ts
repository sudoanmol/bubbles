import { useEffect, useState } from 'react'

/** `value`, updated only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)

    return () => clearTimeout(id)
  }, [value, ms])

  return debounced
}
