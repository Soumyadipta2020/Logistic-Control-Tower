import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { WS_URL } from '../lib/api'

export function useWebSocket(channel: 'visibility' | 'exceptions', onMessage: (type: string, payload: unknown) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const setWsConnected = useStore((s) => s.setWsConnected)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    try {
      const url = channel === 'visibility'
        ? `${WS_URL}/api/v1/visibility/ws/visibility`
        : `${WS_URL}/api/v1/exceptions/ws/exceptions`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => setWsConnected(true)

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          onMessage(msg.type, msg.payload)
        } catch {}
      }

      ws.onclose = () => {
        wsRef.current = null
        setWsConnected(false)
        reconnectTimer.current = setTimeout(connect, 5000)
      }

      ws.onerror = () => ws.close()
    } catch {}
  }, [channel, onMessage, setWsConnected])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])
}
