import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { useChat } from './hooks/useChat'
import ChatWindow from './components/ChatWindow'
import ChatInput from './components/ChatInput'
import type { Document } from './types'

export default function App() {
  const { messages, isLoading, sendMessage, clearMessages } = useChat()
  const [documents, setDocuments] = useState<Document[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [docsLoading, setDocsLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('documents')
      .select('id, name, source_type, chunk_count, created_at')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) console.error('Failed to fetch documents:', error)
        else setDocuments(data ?? [])
        setDocsLoading(false)
      })
  }, [])

  return (
    <div className="app-layout">
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className={`sidebar${sidebarOpen ? ' open' : ' closed'}`} aria-label="Knowledge base">
        <div className="sidebar-header">
          <h2>Knowledge Base</h2>
          <button
            className="icon-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <ul className="doc-list" aria-label="Ingested documents">
          {docsLoading && <li className="doc-empty">Loading…</li>}
          {!docsLoading && documents.length === 0 && (
            <li className="doc-empty">
              No documents yet.<br />
              <code>node src/index.js file.pdf</code>
            </li>
          )}
          {documents.map(doc => (
            <li key={doc.id} className="doc-item">
              <span className={`doc-type ${doc.source_type}`}>{doc.source_type.toUpperCase()}</span>
              <span className="doc-name" title={doc.name}>{doc.name}</span>
              <span className="doc-meta">{doc.chunk_count ?? 0} chunks</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Main chat area ───────────────────────────────────────── */}
      <main className="chat-area">
        <header className="chat-header">
          {!sidebarOpen && (
            <button
              className="icon-btn"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
          )}
          <h1>RAG Chatbot</h1>
          <button
            className="clear-btn"
            onClick={clearMessages}
            disabled={isLoading || messages.length === 0}
          >
            Clear chat
          </button>
        </header>

        <ChatWindow messages={messages} />
        <ChatInput onSend={sendMessage} isLoading={isLoading} />
      </main>
    </div>
  )
}
