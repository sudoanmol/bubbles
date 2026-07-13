import { useWebSocket } from '@/contexts/websocket-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebounceCallback } from 'usehooks-ts'

export type TypingUser = {
  user_id: string
  username: string
}

// If the typist's typing_stop never arrives (dropped connection, closed tab),
// the indicator expires on its own instead of sticking forever.
const TYPING_EXPIRY_MS = 5000
// While typing continues, re-send typing_start on this interval so receivers'
// expiry timers keep getting refreshed. Must be < TYPING_EXPIRY_MS.
const TYPING_REFRESH_MS = 3000

export function useTypingIndicator(chatId: string, currentUserId: string) {
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingUser>>(new Map())
  const { send, on } = useWebSocket()
  const isTypingRef = useRef(false)
  const lastStartSentAtRef = useRef(0)
  const expiryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const removeTypingUser = useCallback((userId: string) => {
    const timer = expiryTimersRef.current.get(userId)
    if (timer) {
      clearTimeout(timer)
      expiryTimersRef.current.delete(userId)
    }
    setTypingUsers((prev) => {
      if (!prev.has(userId)) return prev
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
  }, [])

  const sendTypingStart = useCallback(() => {
    const now = Date.now()
    if (!isTypingRef.current || now - lastStartSentAtRef.current >= TYPING_REFRESH_MS) {
      if (send('typing_start', { chat_id: chatId })) {
        isTypingRef.current = true
        lastStartSentAtRef.current = now
      }
    }
  }, [send, chatId])

  const sendTypingStop = useCallback(() => {
    if (isTypingRef.current) {
      send('typing_stop', { chat_id: chatId })
      isTypingRef.current = false
    }
  }, [send, chatId])

  const debouncedTypingStop = useDebounceCallback(sendTypingStop, 2000)

  const handleTyping = useCallback(() => {
    sendTypingStart()
    debouncedTypingStop()
  }, [sendTypingStart, debouncedTypingStop])

  const stopTyping = useCallback(() => {
    debouncedTypingStop.cancel()
    sendTypingStop()
  }, [debouncedTypingStop, sendTypingStop])

  useEffect(() => {
    const timers = expiryTimersRef.current

    const unsubscribeStart = on('typing_start', (payload: TypingUser & { chat_id: string }) => {
      if (payload.chat_id !== chatId || payload.user_id === currentUserId) return

      const existingTimer = timers.get(payload.user_id)
      if (existingTimer) clearTimeout(existingTimer)
      timers.set(
        payload.user_id,
        setTimeout(() => removeTypingUser(payload.user_id), TYPING_EXPIRY_MS)
      )

      setTypingUsers((prev) => {
        const existing = prev.get(payload.user_id)
        if (existing && existing.username === payload.username) return prev
        const next = new Map(prev)
        next.set(payload.user_id, {
          user_id: payload.user_id,
          username: payload.username,
        })
        return next
      })
    })

    const unsubscribeStop = on('typing_stop', (payload: TypingUser & { chat_id: string }) => {
      if (payload.chat_id !== chatId) return
      removeTypingUser(payload.user_id)
    })

    return () => {
      unsubscribeStart()
      unsubscribeStop()
      stopTyping()
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      setTypingUsers(new Map())
    }
  }, [chatId, currentUserId, on, stopTyping, removeTypingUser])

  return {
    typingUsers: Array.from(typingUsers.values()),
    handleTyping,
    stopTyping,
  }
}
