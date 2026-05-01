import ReactMarkdown from 'react-markdown'
import type { Message } from '../types'
import SourceBadge from './SourceBadge'

interface Props {
  message: Message
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`message-bubble ${isUser ? 'user' : 'assistant'}${message.error ? ' error' : ''}`}>
      <div className="bubble-content">
        {isUser ? (
          <p>{message.content}</p>
        ) : (
          <>
            <ReactMarkdown>{message.content || ' '}</ReactMarkdown>
            {message.isStreaming && (
              <span className="cursor-blink" aria-hidden="true" />
            )}
          </>
        )}
      </div>

      {!isUser && !message.isStreaming && message.sources && message.sources.length > 0 && (
        <div className="source-list" aria-label="Sources">
          <span className="source-label">Sources:</span>
          {message.sources.map((src, i) => (
            <SourceBadge key={i} name={src.name} />
          ))}
        </div>
      )}
    </div>
  )
}
