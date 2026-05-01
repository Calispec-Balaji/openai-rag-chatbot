import { useEffect, useRef } from 'react'
import type { Message } from '../types'
import MessageBubble from './MessageBubble'

interface Props {
  messages: Message[]
}

export default function ChatWindow({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastContent = messages[messages.length - 1]?.content

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, lastContent])

  return (
    <div className="chat-window" role="log" aria-live="polite" aria-label="Chat messages">
      {messages.length === 0 && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
          </svg>
          <p>Ask a question about your documents</p>
          <p className="empty-hint">Ingest PDF or DOCX files first using the local ingestion script.</p>
        </div>
      )}

      {messages.map(message => (
        <MessageBubble key={message.id} message={message} />
      ))}

      <div ref={bottomRef} />
    </div>
  )
}
