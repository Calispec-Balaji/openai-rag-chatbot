export type MessageRole = 'user' | 'assistant'

export interface Source {
  name: string
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  sources?: Source[]
  isStreaming?: boolean
  error?: boolean
}

export interface ChatHistoryItem {
  role: MessageRole
  content: string
}

export interface Document {
  id: string
  name: string
  source_type: 'pdf' | 'docx'
  chunk_count: number
  created_at: string
}
