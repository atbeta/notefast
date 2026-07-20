import { useState, useRef, useEffect } from 'react'
import { Send, X, Loader2, Minimize2, Maximize2, ExternalLink, MessageSquareText } from 'lucide-react'
import { request, fetchWithAuth } from '../hooks/useAPI'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface Citation {
  block_id: string
  doc_id: string
  doc_title: string
  snippet: string
  score: number
  type?: string
}

interface RetrievalInfo {
  fts_hits: number
  semantic_hits: number
  reranked: boolean
  model?: string
}

interface AIChatPanelProps {
  contextDocId?: string
  contextContent?: string
  contextDocTitle?: string
  isOpen: boolean
  onClose: () => void
  /** 展开状态由 Layout 提升管理，使主内容区 padding 与面板宽度一致 */
  expanded: boolean
  onToggleExpand: () => void
}

export default function AIChatPanel({
  contextDocId,
  contextDocTitle,
  isOpen,
  onClose,
  expanded,
  onToggleExpand,
}: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [citations, setCitations] = useState<Citation[]>([])
  const [retrieval, setRetrieval] = useState<RetrievalInfo | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [capabilities, setCapabilities] = useState<{ chat: boolean; reranker: boolean; embedding: boolean } | null>(null)
  const [configMissing, setConfigMissing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // 拉取能力；chat 关闭时直接提示
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    request<{ chat: boolean; reranker: boolean; embedding: boolean }>('/ai/capabilities')
      .then((cap) => {
        if (cancelled) return
        setCapabilities(cap)
        setConfigMissing(!cap.chat)
      })
      .catch(() => {
        if (cancelled) return
        setConfigMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    const newHistory: Message[] = [...messages, { role: 'user', content: userMessage }]
    setMessages(newHistory)
    setCitations([])
    setRetrieval(null)
    setLoading(true)
    setConfigMissing(false)

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetchWithAuth('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newHistory.map((m) => ({ role: m.role, content: m.content })),
          context_doc_id: contextDocId,
          top_k: 5,
        }),
        signal: ac.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(err.message || `HTTP ${res.status}`)
      }

      // SSE 解析
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantText = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          let eventName = 'message'
          let data = ''
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue

          try {
            const payload = JSON.parse(data)
            if (eventName === 'retrieval') {
              setRetrieval({
                fts_hits: payload.retrieval?.fts_hits ?? 0,
                semantic_hits: payload.retrieval?.semantic_hits ?? 0,
                reranked: payload.retrieval?.reranked ?? false,
                model: payload.retrieval?.model,
              })
              setCitations(payload.citations || [])
            } else if (eventName === 'token') {
              assistantText += payload.content || ''
              setMessages((prev) => {
                const next = [...prev]
                if (next.length > 0 && next[next.length - 1]!.role === 'assistant') {
                  next[next.length - 1] = { role: 'assistant', content: assistantText }
                } else {
                  next.push({ role: 'assistant', content: assistantText })
                }
                return next
              })
            } else if (eventName === 'done') {
              setCitations(payload.citations || [])
            } else if (eventName === 'error') {
              throw new Error(payload.message || 'LLM 错误')
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'LLM 错误') {
              // 忽略单帧解析失败
            } else if (parseErr instanceof Error) {
              throw parseErr
            }
          }
        }
      }

      // 确保最后一条 assistant 始终存在
      if (assistantText) {
        setMessages((prev) => {
          if (prev.length > 0 && prev[prev.length - 1]!.role === 'assistant') return prev
          return [...prev, { role: 'assistant', content: assistantText }]
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((prev) => [...prev, { role: 'assistant', content: `请求失败: ${msg}` }])
      if (msg.includes('未配置') || msg.includes('not_configured')) {
        setConfigMissing(true)
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const handleStop = () => {
    if (abortRef.current) abortRef.current.abort()
    setLoading(false)
  }

  const handleClear = () => {
    setMessages([])
    setCitations([])
    setRetrieval(null)
  }

  return (
    <div
      className={`fixed top-0 right-0 h-screen bg-card border-l border-border shadow-[var(--shadow-floating)] transition-all duration-300 z-40 flex flex-col
        ${expanded ? 'w-[600px]' : 'w-[400px]'}
      `}
    >
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-border shrink-0 bg-background/40">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <MessageSquareText className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
          <span>聊天 · 知识库</span>
          {capabilities && (
            <span className="text-[10px] text-muted-foreground font-normal">
              {capabilities.embedding && '·emb'} {capabilities.reranker && '·rerank'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              title="清空对话"
            >
              清空
            </button>
          )}
          <button
            onClick={onToggleExpand}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            title="关闭面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {configMissing ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground space-y-3">
            <MessageSquareText className="w-7 h-7 mb-1 opacity-50" strokeWidth={1.25} />
            <p className="text-sm">聊天未配置</p>
            <p className="text-xs max-w-[260px]">
              需要在 Web UI <span className="text-primary font-medium">/settings/ai</span> 配置 Chat 模型
              （API Key + Base URL + 模型名）。
            </p>
            <a
              href="/settings/ai"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              打开设置 <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground space-y-3 opacity-80">
            <MessageSquareText className="w-7 h-7 mb-1 opacity-50" strokeWidth={1.25} />
            <p className="text-sm">准备就绪</p>
            {contextDocTitle ? (
              <p className="text-xs">
                当前文档《<span className="text-foreground font-medium">{contextDocTitle}</span>》会作为优先上下文。
              </p>
            ) : (
              <p className="text-xs">向知识库提问，引用片段会自动回链到原文。</p>
            )}
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    msg.role === 'user'
                      ? 'bg-ink text-ink-foreground'
                      : 'bg-accent text-foreground'
                  }`}
                >
                  {msg.role === 'user' ? 'U' : <MessageSquareText className="w-4 h-4" strokeWidth={1.5} />}
                </div>
                <div className="max-w-[80%] space-y-1">
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-ink text-ink-foreground rounded-tr-sm'
                        : 'bg-muted/50 text-foreground border border-border/50 rounded-tl-sm'
                    }`}
                  >
                    {msg.content}
                  </div>
                  {/* 对最后一条 assistant 消息，把引用列表展示在下方 */}
                  {msg.role === 'assistant' && idx === messages.length - 1 && citations.length > 0 && (
                    <div className="rounded-lg border border-border/40 bg-background/40 px-3 py-2 space-y-1">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        引用 · {retrieval?.reranked ? `reranked (${retrieval.model})` : 'hybrid search'}
                        {retrieval && ` · FTS ${retrieval.fts_hits} · semantic ${retrieval.semantic_hits}`}
                      </div>
                      <ol className="space-y-1">
                        {citations.map((c, ci) => (
                          <li key={c.block_id} className="text-[11px] text-muted-foreground">
                            <span className="text-primary font-mono mr-1">[{ci + 1}]</span>
                            <span className="text-foreground">{c.doc_title}</span>
                            <span className="mx-1">·</span>
                            <span className="line-clamp-1 inline">{c.snippet}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-accent text-foreground flex items-center justify-center shrink-0">
              <MessageSquareText className="w-4 h-4" strokeWidth={1.5} />
            </div>
            <div className="bg-muted/50 border border-border/50 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">
                {retrieval ? '生成中...' : '检索中...'}
              </span>
              <button
                onClick={handleStop}
                className="ml-2 text-[10px] text-muted-foreground hover:text-foreground"
              >
                停止
              </button>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-border bg-background">
        <form
          onSubmit={handleSubmit}
          className="relative flex items-end gap-2 bg-card border border-border rounded-xl shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all p-2"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(e)
              }
            }}
            placeholder={
              contextDocTitle ? `询问关于《${contextDocTitle}》的问题...` : '问我任何问题...'
            }
            disabled={configMissing}
            className="flex-1 max-h-32 min-h-[40px] bg-transparent border-none focus:outline-none resize-none text-sm py-2 px-2 placeholder:text-muted-foreground/50 leading-relaxed disabled:opacity-50"
            rows={1}
          />
          <button
            type="submit"
            disabled={!input.trim() || loading || configMissing}
            className="w-8 h-8 rounded-lg bg-ink text-ink-foreground flex items-center justify-center shrink-0 hover:bg-ink-hover active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all mb-1"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </button>
        </form>
        <div className="text-[10px] text-center text-muted-foreground/60 mt-2">
          按 Enter 发送，Shift + Enter 换行
        </div>
      </div>
    </div>
  )
}
