import { useState, useCallback, useRef } from 'react'
import type { Message, Source, ChatHistoryItem } from '../types'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/chat`

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (query: string) => {
    if (!query.trim() || isLoading) return

    // Abort any in-progress stream before starting a new one
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: query.trim(),
    }

    const assistantId = crypto.randomUUID()
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    }

    // Snapshot messages for history before we add the new ones
    setMessages(prev => {
      return [...prev, userMessage, assistantMessage]
    })
    setIsLoading(true)

    // Build conversation history from current messages (last 3 turns = 6 messages)
    const history: ChatHistoryItem[] = messages
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const response = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ query: query.trim(), history }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        let errMsg = `HTTP ${response.status}`
        try { errMsg = await response.text() } catch { /* ignore */ }
        throw new Error(errMsg)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pendingSources: Source[] = []
      let currentEvent = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE lines; keep the incomplete trailing line in buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
            continue
          }

          if (!line.startsWith('data: ')) continue

          const data = line.slice(6)

          if (data === '[DONE]') {
            // Stream finished — attach sources and mark complete
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, sources: pendingSources }
                  : m
              )
            )
            break
          }

          if (currentEvent === 'sources') {
            try {
              const parsed = JSON.parse(data)
              pendingSources = (parsed.sources as string[]).map(name => ({ name }))
            } catch { /* ignore malformed */ }
            currentEvent = 'message'
            continue
          }

          if (currentEvent === 'error') {
            try {
              const parsed = JSON.parse(data)
              throw new Error(parsed.error)
            } catch (e) {
              throw e instanceof SyntaxError ? new Error('Stream error') : e
            }
          }

          // Standard OpenAI-format SSE delta: {"choices":[{"delta":{"content":"..."}}]}
          try {
            const parsed = JSON.parse(data)
            const token: string = parsed.choices?.[0]?.delta?.content ?? ''
            if (token) {
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId
                    ? { ...m, content: m.content + token }
                    : m
                )
              )
            }
          } catch { /* ignore malformed SSE lines */ }
        }
      }

    } catch (err) {
      if ((err as Error).name === 'AbortError') return // intentional cancel

      console.error('[useChat] error:', err)
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                isStreaming: false,
                content: 'Something went wrong. Please try again.',
                error: true,
              }
            : m
        )
      )
    } finally {
      setIsLoading(false)
    }
  }, [messages, isLoading])

  const clearMessages = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    setIsLoading(false)
  }, [])

  return { messages, isLoading, sendMessage, clearMessages }
}
