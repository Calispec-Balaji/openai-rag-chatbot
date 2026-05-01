import { useRef, type KeyboardEvent } from 'react'

interface Props {
  onSend: (query: string) => void
  isLoading: boolean
}

export default function ChatInput({ onSend, isLoading }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function submit() {
    const value = textareaRef.current?.value.trim()
    if (!value || isLoading) return
    onSend(value)
    if (textareaRef.current) textareaRef.current.value = ''
  }

  return (
    <div className="chat-input-container">
      <textarea
        ref={textareaRef}
        className="chat-textarea"
        placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
        rows={1}
        disabled={isLoading}
        onKeyDown={handleKeyDown}
        aria-label="Message input"
        aria-disabled={isLoading}
      />
      <button
        className={`send-button${isLoading ? ' loading' : ''}`}
        onClick={submit}
        disabled={isLoading}
        aria-label={isLoading ? 'Generating response…' : 'Send message'}
      >
        {isLoading ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        )}
      </button>
    </div>
  )
}
