import { getAuthTokenFn } from '@/server/chat'
import type { ChatInfo } from '@/types/chat'
import { useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

type EventType =
  | 'message_sent'
  | 'message_edited'
  | 'message_deleted'
  | 'message_read'
  | 'typing_start'
  | 'typing_stop'
  | 'join_chat'
  | 'leave_chat'
  | 'chat_created'
  | 'chat_removed'

type WSMessage = {
  type: EventType
  payload: any
}

type EventHandler = (payload: any) => void

type WebSocketContextType = {
  send: (type: EventType, payload: any) => boolean
  on: (type: EventType, handler: EventHandler) => () => void
  joinChat: (chatId: string) => void
  leaveChat: (chatId: string) => void
  isConnected: boolean
}

const WebSocketContext = createContext<WebSocketContextType | null>(null)

const TOKEN_EXPIRY_SKEW = 10_000

function isTokenExpired(token: string) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp !== 'number') return false
    return payload.exp * 1000 <= Date.now() + TOKEN_EXPIRY_SKEW
  } catch {
    return false
  }
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const eventHandlersRef = useRef<Map<EventType, Set<EventHandler>>>(new Map())
  const shouldReconnectRef = useRef(true)
  const pendingReadReceiptsRef = useRef<Array<{ type: EventType; payload: any; timestamp: number }>>([])
  const joinedChatsRef = useRef<Set<string>>(new Set())
  const [isConnected, setIsConnected] = useState(false)

  const queryClient = useQueryClient()
  const getAuthTokenQuery = useServerFn(getAuthTokenFn)

  const scheduleReconnect = useCallback((connect: () => void, delay: number) => {
    if (!shouldReconnectRef.current) return
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectAttemptsRef.current++
      connect()
    }, delay)
  }, [])

  const connect = useCallback(async () => {
    // A CONNECTING socket counts too, otherwise a re-entrant call leaks a
    // second socket that keeps processing events.
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)
    ) {
      return
    }

    if (!shouldReconnectRef.current) {
      return
    }

    // Fetch a fresh token for every attempt; reusing a token captured at
    // mount makes every reconnect fail once it expires.
    let token: string | null = null
    try {
      token = await queryClient.fetchQuery({
        queryKey: ['authToken'],
        queryFn: async () => getAuthTokenQuery(),
        staleTime: 0,
      })
    } catch (error) {
      console.error('[WebSocket] Failed to fetch auth token:', error)
    }

    if (!token || isTokenExpired(token)) {
      console.warn('[WebSocket] No valid auth token, retrying in 60s')
      scheduleReconnect(connect, 60000)
      return
    }

    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws'

    console.log('[WebSocket] Connecting...')
    const ws = new WebSocket(wsUrl, `Bearer.${token}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[WebSocket] Connected')
      reconnectAttemptsRef.current = 0
      setIsConnected(true)

      // Join every chat we know about: the query cache when it has resolved,
      // otherwise whatever we had joined before this (re)connect.
      const chats = queryClient.getQueryData<ChatInfo[]>(['chats'])
      chats?.forEach((chat) => joinedChatsRef.current.add(chat.id))
      joinedChatsRef.current.forEach((chatId) => {
        ws.send(JSON.stringify({ type: 'join_chat', payload: { chat_id: chatId } }))
      })

      // Flush read receipts queued while offline, dropping stale ones
      const MAX_READ_RECEIPT_AGE = 60000
      const now = Date.now()
      const receipts = pendingReadReceiptsRef.current.filter((msg) => now - msg.timestamp < MAX_READ_RECEIPT_AGE)
      pendingReadReceiptsRef.current = []
      receipts.forEach(({ type, payload }) => {
        ws.send(JSON.stringify({ type, payload }))
      })
    }

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
        const handlers = eventHandlersRef.current.get(message.type)

        if (handlers) {
          handlers.forEach((handler) => handler(message.payload))
        }
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error)
      }
    }

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
    }

    ws.onclose = () => {
      setIsConnected(false)
      if (wsRef.current === ws) {
        wsRef.current = null
      }

      if (!shouldReconnectRef.current) {
        return
      }

      const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000)
      console.log(`[WebSocket] Reconnecting in ${backoffDelay}ms...`)
      scheduleReconnect(connect, backoffDelay)
    }
  }, [queryClient, getAuthTokenQuery, scheduleReconnect])

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = undefined
    }

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  const send = useCallback((type: EventType, payload: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }))
      return true
    }

    // Only read receipts are worth queueing: typing events are stale the
    // moment the socket drops, and room membership is replayed from
    // joinedChatsRef on reconnect.
    if (type === 'message_read') {
      const MAX_PENDING = 50
      pendingReadReceiptsRef.current.push({ type, payload, timestamp: Date.now() })
      if (pendingReadReceiptsRef.current.length > MAX_PENDING) {
        pendingReadReceiptsRef.current = pendingReadReceiptsRef.current.slice(-MAX_PENDING)
      }
    }
    return false
  }, [])

  const on = useCallback((type: EventType, handler: EventHandler) => {
    if (!eventHandlersRef.current.has(type)) {
      eventHandlersRef.current.set(type, new Set())
    }
    eventHandlersRef.current.get(type)!.add(handler)

    return () => {
      const handlers = eventHandlersRef.current.get(type)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) {
          eventHandlersRef.current.delete(type)
        }
      }
    }
  }, [])

  const joinChat = useCallback(
    (chatId: string) => {
      joinedChatsRef.current.add(chatId)
      send('join_chat', { chat_id: chatId })
    },
    [send]
  )

  const leaveChat = useCallback(
    (chatId: string) => {
      joinedChatsRef.current.delete(chatId)
      send('leave_chat', { chat_id: chatId })
    },
    [send]
  )

  // Join rooms reactively whenever the chats cache changes, so a socket that
  // opened before the chats query resolved (or a refetch that found new
  // chats) still ends up subscribed everywhere.
  useEffect(() => {
    const joinKnownChats = () => {
      const chats = queryClient.getQueryData<ChatInfo[]>(['chats'])
      chats?.forEach((chat) => {
        if (!joinedChatsRef.current.has(chat.id)) {
          joinChat(chat.id)
        }
      })
    }

    joinKnownChats()

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === 'chats') {
        joinKnownChats()
      }
    })

    return unsubscribe
  }, [queryClient, joinChat])

  useEffect(() => {
    const unsubscribeCreated = on('chat_created', (payload: { chat_id: string }) => {
      joinChat(payload.chat_id)
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    })

    const unsubscribeRemoved = on('chat_removed', (payload: { chat_id: string }) => {
      joinedChatsRef.current.delete(payload.chat_id)
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['chat', payload.chat_id] })
    })

    return () => {
      unsubscribeCreated()
      unsubscribeRemoved()
    }
  }, [on, joinChat, queryClient])

  useEffect(() => {
    shouldReconnectRef.current = true
    connect()

    return () => {
      disconnect()
    }
  }, [connect, disconnect])

  const value: WebSocketContextType = {
    send,
    on,
    joinChat,
    leaveChat,
    isConnected,
  }

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
}

export function useWebSocket() {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}
