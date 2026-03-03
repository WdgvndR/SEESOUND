import { useEffect, useRef, useState, useCallback } from 'react'

const WS_URL = 'ws://localhost:8000/ws'

/**
 * useWebSocket
 * Manages a persistent WebSocket connection to the SEESOUND backend.
 * Automatically reconnects if the socket closes unexpectedly.
 *
 * Parameters:
 *   onMessage  — optional direct callback for every message (bypasses React state).
 *                Use this for high-frequency messages like 'frame'.
 *                If provided, non-'frame' messages are ALSO forwarded to the
 *                messages state array so other consumers still work normally.
 *
 * Returns:
 *   status      — 'connecting' | 'open' | 'closed' | 'error'
 *   messages    — array of non-frame parsed JSON messages (up to 100)
 *   sendMessage — function(payload: object) → sends JSON to the server
 *   clearLog    — empties the messages array
 */
export function useWebSocket(onMessage) {
    const ws = useRef(null)
    const [status, setStatus] = useState('closed')
    const [messages, setMessages] = useState([])
    const reconnectTimer = useRef(null)
    // Keep a stable ref to the callback so the WS handler never goes stale
    const onMessageRef = useRef(onMessage)
    useEffect(() => { onMessageRef.current = onMessage }, [onMessage])

    const connect = useCallback(() => {
        // Guard against CONNECTING (0) as well as OPEN (1) to prevent duplicate sockets
        if (ws.current && ws.current.readyState <= WebSocket.OPEN) return

        setStatus('connecting')
        const socket = new WebSocket(WS_URL)
        ws.current = socket

        socket.onopen = () => {
            setStatus('open')
            clearTimeout(reconnectTimer.current)
        }

        socket.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data)
                // Always call the direct callback if provided
                if (onMessageRef.current) onMessageRef.current(parsed)
                // Only push non-frame messages into React state
                // (frames arrive too fast and would overflow the buffer)
                if (parsed.type !== 'frame') {
                    setMessages((prev) => [...prev.slice(-99), parsed])
                }
            } catch {
                const fallback = { raw: event.data }
                if (onMessageRef.current) onMessageRef.current(fallback)
                setMessages((prev) => [...prev.slice(-99), fallback])
            }
        }

        socket.onerror = () => {
            setStatus('error')
        }

        socket.onclose = () => {
            setStatus('closed')
            // Auto-reconnect after 2 s
            reconnectTimer.current = setTimeout(connect, 2000)
        }
    }, [])

    useEffect(() => {
        connect()
        return () => {
            clearTimeout(reconnectTimer.current)
            ws.current?.close()
        }
    }, [connect])

    const sendMessage = useCallback((payload) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(payload))
        } else {
            console.warn('[WS] Cannot send — socket is not open')
        }
    }, [])

    const clearLog = useCallback(() => setMessages([]), [])

    return { status, messages, sendMessage, clearLog }
}
