import { useState, useRef, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import {
  Send,
  X,
  Loader2,
  Minimize2,
  Maximize2,
  ExternalLink,
  MessageSquareText,
  ChevronRight,
  Brain,
  Binary,
  ArrowUpDown,
  Inbox,
  Archive,
  CalendarDays,
  ImagePlus,
  Mic,
  MicOff,
  User,
  Sparkles,
} from 'lucide-react'
import { request, fetchWithAuth, ApiError } from '../hooks/useAPI'
import { useScrollFade } from '../hooks/useScrollFade'
import ChatMarkdown from './ChatMarkdown'
import ConfirmDialog from './ConfirmDialog'
import { Tooltip } from './ui'

interface AiSkill {
  id: string
  name: string
  description: string
  icon: string
  prompt: string
}

const SKILL_ICONS: Record<string, typeof Inbox> = {
  inbox: Inbox,
  archive: Archive,
  calendar: CalendarDays,
}

/** Web Speech API 的最小类型（lib.dom 不含 webkitSpeechRecognition，自行收窄） */
interface SpeechResultEvent {
  resultIndex: number
  results: Array<{ isFinal: boolean; 0: { transcript: string } }>
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((ev: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  /** 用户消息附带的图片（data URL，仅本地展示；历史轮次不重复发送） */
  images?: string[]
}

/** 待发送的图片附件（base64 data URL 随消息透传给视觉模型，不落库） */
interface Attachment {
  dataUrl: string
  mime: string
  name: string
}

interface Citation {
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
  timing?: {
    fts_ms: number
    embed_query_ms: number
    semantic_ms: number
    rerank_ms: number
    total_ms: number
  }
}

/** AI 建议写入提案（写工具被 agent loop 触发但不直接执行，等用户确认） */
interface WriteProposal {
  id: string
  tool: 'notefast_create_note' | 'notefast_append_to_doc' | 'notefast_update_block'
  args: Record<string, unknown>
  /** executing=正在写入；done=已写入；dismissed=已拒绝；error=写入失败 */
  status: 'pending' | 'executing' | 'done' | 'dismissed' | 'error'
  error?: string
}

interface AIChatPanelProps {
  contextDocId?: string
  isOpen: boolean
  onClose: () => void
  /** 展开状态由 Layout 提升管理，使主内容区 padding 与面板宽度一致 */
  expanded: boolean
  onToggleExpand: () => void
}

export default function AIChatPanel({
  contextDocId,
  isOpen,
  onClose,
  expanded,
  onToggleExpand,
}: AIChatPanelProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<Message[]>([])
  const [citations, setCitations] = useState<Citation[]>([])
  const [retrieval, setRetrieval] = useState<RetrievalInfo | null>(null)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [capabilities, setCapabilities] = useState<{ chat: boolean; reranker: boolean; embedding: boolean; vision?: boolean } | null>(null)
  const [configMissing, setConfigMissing] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [skills, setSkills] = useState<AiSkill[]>([])
  const [proposals, setProposals] = useState<WriteProposal[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesFadeRef = useScrollFade<HTMLDivElement>()
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 语音转文字：识别中的实例 + 开始识别时的输入框基底文本
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const speechBaseRef = useRef('')
  const [listening, setListening] = useState(false)
  const speechSupported = typeof window !== 'undefined' && speechRecognitionCtor() !== null

  const toggleListen = () => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = i18next.resolvedLanguage || 'zh-CN'
    rec.interimResults = true
    rec.continuous = true
    speechBaseRef.current = input.trim() ? input.trim() + ' ' : ''
    let finalText = ''
    rec.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      setInput(speechBaseRef.current + finalText + interim)
    }
    rec.onend = () => {
      recognitionRef.current = null
      setListening(false)
    }
    rec.onerror = () => {
      recognitionRef.current = null
      setListening(false)
    }
    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }

  // 卸载时停止识别
  useEffect(() => () => recognitionRef.current?.abort(), [])

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, toolStatus])

  // 拉取能力；chat 关闭时直接提示
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    request<{ chat: boolean; reranker: boolean; embedding: boolean; vision?: boolean }>('/ai/capabilities')
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

  // 内置技能（整理收集箱 / 归档建议 / 周期回顾）：点击填入输入框，用户可改再发
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    request<{ skills: AiSkill[] }>('/ai/skills')
      .then((r) => { if (!cancelled) setSkills(r.skills) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isOpen])

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [])

  /** 同源引用合并：一份文档被引多个 block 时只列一次标题，片段以紧凑子列表收纳 */
  const groupedCitations = useMemo(() => {
    const map = new Map<string, { doc_id: string; doc_title: string; items: Citation[] }>()
    for (const c of citations) {
      const existing = map.get(c.doc_id)
      if (existing) {
        existing.items.push(c)
      } else {
        map.set(c.doc_id, { doc_id: c.doc_id, doc_title: c.doc_title, items: [c] })
      }
    }
    return Array.from(map.values())
  }, [citations])

  const upsertAssistant = (patch: { content?: string; reasoning?: string }) => {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.role === 'assistant') {
        next[next.length - 1] = {
          role: 'assistant',
          content: patch.content !== undefined ? patch.content : last.content,
          reasoning: patch.reasoning !== undefined ? patch.reasoning : last.reasoning,
        }
      } else {
        next.push({
          role: 'assistant',
          content: patch.content ?? '',
          reasoning: patch.reasoning,
        })
      }
      return next
    })
  }

  const addAttachments = (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > 10 * 1024 * 1024) {
        console.warn(`[chat] 图片超过 10MB，已跳过: ${file.name}`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result || '')
        if (!dataUrl.startsWith('data:image/')) return
        setAttachments((prev) => [...prev, { dataUrl, mime: file.type, name: file.name }])
      }
      reader.readAsDataURL(file)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasImages = attachments.length > 0
    if ((!input.trim() && !hasImages) || loading) return
    if (listening) recognitionRef.current?.stop()

    // 纯图片消息给一段兜底文本：服务端检索与校验都需要非空文本
    const userMessage = input.trim() || t('chat.visionFallbackText')
    const sentAttachments = attachments
    setInput('')
    setAttachments([])
    const newHistory: Message[] = [
      ...messages,
      { role: 'user', content: userMessage, ...(hasImages ? { images: sentAttachments.map((a) => a.dataUrl) } : {}) },
    ]
    setMessages(newHistory)
    setCitations([])
    setRetrieval(null)
    setToolStatus(null)
    setLoading(true)
    setConfigMissing(false)

    // 图片只随当轮发送（data URL 透传给视觉模型），历史轮次保持纯文本以控制 token 成本
    const outgoing = newHistory.map((m, i) => {
      if (i === newHistory.length - 1 && hasImages) {
        return {
          role: m.role,
          content: [
            { type: 'text', text: userMessage },
            ...sentAttachments.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
          ],
        }
      }
      return { role: m.role, content: m.content }
    })

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetchWithAuth('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: outgoing,
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
      let reasoningText = ''

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
                timing: payload.retrieval?.timing,
              })
              setCitations(payload.citations || [])
            } else if (eventName === 'tool') {
              setToolStatus(t('chat.callingTool', { tool: payload.tool || t('chat.tool') }))
            } else if (eventName === 'write_proposal') {
              setToolStatus(null)
              setProposals((prev) => [
                ...prev,
                {
                  id: `${payload.tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  tool: payload.tool,
                  args: payload.args || {},
                  status: 'pending',
                },
              ])
            } else if (eventName === 'reasoning') {
              reasoningText += payload.content || ''
              upsertAssistant({ reasoning: reasoningText, content: assistantText })
            } else if (eventName === 'token') {
              setToolStatus(null)
              assistantText += payload.content || ''
              upsertAssistant({ content: assistantText, reasoning: reasoningText || undefined })
            } else if (eventName === 'done') {
              setToolStatus(null)
              setCitations(payload.citations || [])
              if (payload.retrieval) {
                setRetrieval({
                  fts_hits: payload.retrieval.fts_hits ?? 0,
                  semantic_hits: payload.retrieval.semantic_hits ?? 0,
                  reranked: payload.retrieval.reranked ?? false,
                  model: payload.retrieval.model,
                  timing: payload.retrieval.timing,
                })
              }
            } else if (eventName === 'error') {
              throw new Error(payload.message || t('chat.llmError'))
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== t('chat.llmError')) {
              // 单帧解析失败：SSE keep-alive 注释行或 provider 心跳多见，warn 即可
              console.warn('[chat-sse] drop unparseable frame:', parseErr.message)
            } else if (parseErr instanceof Error) {
              throw parseErr
            }
          }
        }
      }

      // 确保最后一条 assistant 始终存在
      if (assistantText || reasoningText) {
        upsertAssistant({
          content: assistantText,
          reasoning: reasoningText || undefined,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if ((err as { name?: string })?.name === 'AbortError') {
        // 用户停止：保留已生成内容
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: t('chat.requestFailed', { msg }) }])
        // 未配置：err.code 是稳定判据（不再依赖中文/英文 message 子串）
        if (err instanceof ApiError && err.code === 'not_configured') {
          setConfigMissing(true)
        }
      }
    } finally {
      setLoading(false)
      setToolStatus(null)
      abortRef.current = null
    }
  }

  const handleStop = () => {
    if (abortRef.current) abortRef.current.abort()
    setLoading(false)
    setToolStatus(null)
  }

  const handleClear = () => {
    setMessages([])
    setCitations([])
    setRetrieval(null)
    setToolStatus(null)
    setProposals([])
  }

  /** 拒绝 AI 写提案：仅丢弃，不调用任何写端点 */
  const rejectProposal = (id: string) => {
    setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'dismissed' } : p)))
  }

  /** 确认 AI 写提案：调 /ai/chat/write-confirm 真正写入（与 chat agent loop 解耦的写路径） */
  const confirmProposal = async (id: string) => {
    const prop = proposals.find((p) => p.id === id)
    if (!prop || prop.status !== 'pending') return
    setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'executing' } : p)))
    try {
      const res = await fetchWithAuth('/ai/chat/write-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: prop.tool, args: prop.args }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
        throw new Error(err.message || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { ok?: boolean; doc_id?: string; message?: string }
      setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'done' } : p)))
      // 写入成功 → 追加一条确认消息（引用新文档可跳转）
      if (data.doc_id) {
        upsertAssistantDone(t('chat.writtenDocLink', {
          label: data.message || t('chat.openDoc'),
          docId: data.doc_id,
        }))
      } else {
        upsertAssistantDone(data.message ? t('chat.writtenWithMessage', { message: data.message }) : t('chat.writtenToKb'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'error', error: msg } : p)))
    }
  }

  /** 追加一条独立的 assistant 消息（HTML 渲染，用于写入结果提示） */
  const upsertAssistantDone = (content: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content }])
  }

  const showSpinner = loading && !messages.some((m) => m.role === 'assistant' && (m.content.trim() || m.reasoning))

  return (
    <div
      aria-hidden={!isOpen}
      className={`fixed top-0 right-0 h-screen bg-card border-l border-border shadow-[var(--shadow-floating)] z-40 flex flex-col
        w-full md:w-[400px] ${expanded ? 'md:w-[600px]' : ''}
        transition-[transform,width] duration-[var(--dur)] ease-[var(--ease)]
        ${isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'}
      `}
    >
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-border shrink-0 bg-primary-softer">
        <div className="flex items-center gap-2.5 text-foreground font-medium min-w-0">
          <Sparkles className="w-4 h-4 text-primary shrink-0" strokeWidth={1.75} />
          <span className="truncate">{t('chat.title')}</span>
          <span
            className="shrink-0 text-[10.5px] font-medium px-1.5 py-px rounded border border-primary/25 bg-primary-soft text-primary/90"
            title={contextDocId ? t('chat.contextDocTitle') : t('chat.contextAllTitle')}
          >
            {contextDocId ? t('chat.contextDoc') : t('chat.contextAll')}
          </span>
          {capabilities && (
            <span className="flex items-center gap-1 text-muted-foreground shrink-0">
              {capabilities.embedding && (
                <span title={t('chat.embeddingConfigured')}>
                  <Binary className="w-3 h-3" strokeWidth={1.75} aria-label={t('chat.embeddingConfigured')} />
                </span>
              )}
              {capabilities.reranker && (
                <span title={t('chat.rerankConfigured')}>
                  <ArrowUpDown className="w-3 h-3" strokeWidth={1.75} aria-label={t('chat.rerankConfigured')} />
                </span>
              )}
            </span>
          )}
          {messages.length > 0 && (
            <>
              <span className="text-border shrink-0">|</span>
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0"
                title={t('chat.clearTitle')}
              >
                {t('chat.clear')}
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip label={expanded ? t('chat.collapse') : t('chat.expand')}>
            <button
              onClick={onToggleExpand}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            >
              {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </Tooltip>
          <Tooltip label={t('chat.closePanel')}>
            <button
              onClick={onClose}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesFadeRef} className="scroll-fade flex-1 overflow-y-auto p-4 space-y-6">
        {configMissing ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground space-y-3">
            <MessageSquareText className="w-7 h-7 mb-1 opacity-50" strokeWidth={1.25} />
            <p className="text-sm">{t('chat.notConfigured')}</p>
            <p className="text-xs max-w-[260px]">
              {t('chat.notConfiguredDesc1')} <span className="text-primary font-medium">/settings/ai</span> {t('chat.notConfiguredDesc2')}
            </p>
            <a
              href="/settings/ai"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('chat.openSettings')} <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col h-full min-h-0 pt-2 pb-1">
            <div className="text-center space-y-1.5 mb-5 shrink-0">
              <div className="w-9 h-9 mx-auto rounded-lg bg-primary-soft text-primary grid place-items-center mb-2">
                <Sparkles className="w-4 h-4" strokeWidth={1.5} />
              </div>
              <p className="text-[14px] font-medium text-foreground">{t('chat.askKb')}</p>
              <p className="text-[12px] text-muted-foreground leading-relaxed px-2">
                {contextDocId ? t('chat.emptyDocHint') : t('chat.emptyAllHint')}
              </p>
            </div>
            {skills.length > 0 && (
              <div className="grid gap-2 flex-1 content-start">
                {skills.map((s) => {
                  const SkillIcon = SKILL_ICONS[s.icon] ?? MessageSquareText
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setInput(s.prompt)
                        inputRef.current?.focus()
                      }}
                      className="flex items-start gap-2.5 text-left rounded-lg border border-border/70 bg-card px-3 py-2.5 hover:border-primary/35 hover:bg-primary-softer transition-colors group"
                    >
                      <span className="mt-0.5 w-7 h-7 rounded-md bg-primary-soft text-primary grid place-items-center shrink-0 group-hover:bg-primary/15">
                        <SkillIcon className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-foreground">{s.name}</span>
                        <span className="block text-[11.5px] text-muted-foreground mt-0.5 leading-snug line-clamp-2">
                          {s.description}
                        </span>
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 mt-1 shrink-0 group-hover:text-primary/60" strokeWidth={1.75} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => {
              const isLastAssistant = msg.role === 'assistant' && idx === messages.length - 1
              return (
                <div
                  key={idx}
                  className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                      msg.role === 'user'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-primary-soft text-primary'
                    }`}
                  >
                    {/* 用户 = 人形（中性灰）；AI = Sparkles（与侧栏 AI 入口同标识 + 品牌色） */}
                    {msg.role === 'user' ? (
                      <User className="w-4 h-4" strokeWidth={1.75} />
                    ) : (
                      <Sparkles className="w-4 h-4" strokeWidth={1.75} />
                    )}
                  </div>
                  <div className="max-w-[85%] space-y-1.5 min-w-0">
                    {msg.role === 'assistant' && msg.reasoning ? (
                      <ThinkBlock
                        text={msg.reasoning}
                        streaming={Boolean(loading && isLastAssistant && !msg.content.trim())}
                      />
                    ) : null}
                    {/* 仅空白 token（如 </think> 后的换行）不渲染气泡，避免思考期出现空内容框 */}
                    {(msg.role === 'user' || msg.content.trim()) && (
                      <div
                        className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-ink text-ink-foreground rounded-tr-sm whitespace-pre-wrap'
                            : 'bg-muted/40 text-foreground border border-border/50 rounded-tl-sm'
                        }`}
                      >
                        {msg.role === 'user' ? (
                          <>
                            {msg.images && msg.images.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                {msg.images.map((src, i) => (
                                  <img key={i} src={src} alt={t('chat.attachmentImageAlt')} className="max-h-32 max-w-full rounded-md border border-border/40 object-contain" />
                                ))}
                              </div>
                            )}
                            {msg.content}
                          </>
                        ) : (
                          <ChatMarkdown content={msg.content} />
                        )}
                      </div>
                    )}
                    {isLastAssistant && groupedCitations.length > 0 && (
                      <CitationSources groups={groupedCitations} retrieval={retrieval} />
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
        {proposals.length > 0 && (
          <div className="space-y-3">
            {proposals.map((p) => (
              <WriteProposalCard
                key={p.id}
                proposal={p}
                onConfirm={() => confirmProposal(p.id)}
                onReject={() => rejectProposal(p.id)}
              />
            ))}
          </div>
        )}
        {loading && (
          <div className="flex gap-3">
            {(showSpinner || toolStatus) && (
              <>
                {showSpinner && (
                  <div className="w-8 h-8 rounded-full bg-accent text-foreground flex items-center justify-center shrink-0">
                    <MessageSquareText className="w-4 h-4" strokeWidth={1.5} />
                  </div>
                )}
                <div
                  className={`flex items-center gap-2 ${
                    showSpinner
                      ? 'bg-muted/50 border border-border/50 rounded-2xl rounded-tl-sm px-4 py-3'
                      : 'pl-11 text-xs text-muted-foreground'
                  }`}
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                  <span className="text-xs text-muted-foreground">
                    {toolStatus || (retrieval ? t('chat.generating') : t('chat.retrieving'))}
                  </span>
                  <button
                    onClick={handleStop}
                    className="ml-1 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    {t('chat.stop')}
                  </button>
                </div>
              </>
            )}
            {!showSpinner && !toolStatus && (
              <button
                onClick={handleStop}
                className="ml-11 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('chat.stopGenerating')}
              </button>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-border bg-background">
        {/* 有对话时保留技能 chip；空态已用任务卡片展示，避免重复 */}
        {skills.length > 0 && !configMissing && messages.length > 0 && (
          <div className="flex gap-1.5 mb-2 overflow-x-auto pb-0.5">
            {skills.map((s) => {
              const SkillIcon = SKILL_ICONS[s.icon] ?? MessageSquareText
              return (
                <button
                  key={s.id}
                  type="button"
                  title={s.description}
                  onClick={() => {
                    setInput(s.prompt)
                    inputRef.current?.focus()
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-primary/20 bg-primary-softer text-[11px] text-primary hover:border-primary/40 hover:bg-primary-soft transition-colors whitespace-nowrap shrink-0"
                >
                  <SkillIcon className="w-3 h-3" strokeWidth={1.75} />
                  {s.name}
                </button>
              )
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative group">
                <img src={a.dataUrl} alt={a.name} className="h-14 w-14 rounded-md border border-border/60 object-cover" />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-ink-foreground text-[10px] leading-none flex items-center justify-center opacity-80 hover:opacity-100"
                  title={t('chat.removeAttachment')}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="relative flex items-end gap-2 bg-card border border-border rounded-xl shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all p-2"
        >
          {capabilities?.vision && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addAttachments(e.target.files ?? [])
                  e.target.value = ''
                }}
              />
              <Tooltip label={t('chat.addImageTitle')}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={configMissing}
                  className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                  aria-label={t('chat.addImage')}
                >
                  <ImagePlus className="w-4 h-4" strokeWidth={1.75} />
                </button>
              </Tooltip>
            </>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (!capabilities?.vision) return
              const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
              if (files.length > 0) {
                e.preventDefault()
                addAttachments(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(e)
              }
            }}
            placeholder={t('chat.inputPlaceholder')}
            rows={1}
            disabled={configMissing}
            className="flex-1 resize-none bg-transparent border-0 outline-none text-sm px-2 py-1.5 max-h-32 placeholder:text-muted-foreground disabled:opacity-50"
          />
          {speechSupported && (
            <Tooltip label={listening ? t('chat.stopVoice') : t('chat.startVoiceZh')}>
              <button
                type="button"
                onClick={toggleListen}
                disabled={configMissing}
                className={`p-2 rounded-lg transition-colors disabled:opacity-40 ${
                  listening
                    ? 'text-destructive bg-destructive/10 animate-pulse'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                aria-label={listening ? t('chat.stopVoice') : t('chat.startVoice')}
              >
                {listening ? <MicOff className="w-4 h-4" strokeWidth={1.75} /> : <Mic className="w-4 h-4" strokeWidth={1.75} />}
              </button>
            </Tooltip>
          )}
          <Tooltip label={t('chat.sendTitle')}>
            <button
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || loading || configMissing}
              className="p-2 rounded-lg bg-[rgb(var(--primary))] text-[rgb(var(--primary-foreground))] disabled:opacity-40 hover:bg-[rgb(var(--primary-hover))] transition-colors"
              aria-label={loading ? t('chat.generatingReply') : t('chat.send')}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </Tooltip>        </form>
      </div>

      <ConfirmDialog
        open={showClearConfirm}
        title={t('chat.clearDialogTitle')}
        message={t('chat.clearDialogMessage')}
        confirmLabel={t('chat.clear')}
        destructive
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={() => {
          setShowClearConfirm(false)
          handleClear()
        }}
      />
    </div>
  )
}

/** 单文档下默认展示的片段数；超出折叠，避免引用区压过正文 */
const CITATION_SNIPPET_PREVIEW = 3

function CitationSources({
  groups,
  retrieval,
}: {
  groups: Array<{ doc_id: string; doc_title: string; items: Citation[] }>
  retrieval: RetrievalInfo | null
}) {
  const { t } = useTranslation()
  const [diagOpen, setDiagOpen] = useState(false)
  const [expandedDocs, setExpandedDocs] = useState<ReadonlySet<string>>(() => new Set())
  const totalSnippets = groups.reduce((n, g) => n + g.items.length, 0)

  const hasDiag = Boolean(
    retrieval && (
      retrieval.reranked ||
      retrieval.fts_hits > 0 ||
      retrieval.semantic_hits > 0 ||
      retrieval.timing
    ),
  )

  const toggleDoc = (docId: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className="w-1 h-3.5 rounded-full bg-primary shrink-0" aria-hidden />
        <span className="text-[12px] font-medium text-foreground">{t('chat.citationTitle')}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t('chat.citationStats', { docs: groups.length, segments: totalSnippets })}
        </span>
        {hasDiag && (
          <button
            type="button"
            onClick={() => setDiagOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={diagOpen}
          >
            {t('chat.retrievalDetail')}
            <ChevronRight className={`w-3 h-3 transition-transform ${diagOpen ? 'rotate-90' : ''}`} strokeWidth={2} />
          </button>
        )}
      </div>

      {diagOpen && retrieval && (
        <div className="px-3 py-1.5 border-b border-border/40 text-[10.5px] text-muted-foreground leading-relaxed tabular-nums font-mono">
          {retrieval.reranked
            ? t('chat.rerankedWith', { model: retrieval.model || 'reranker' })
            : t('chat.hybridSearch')}
          {(retrieval.fts_hits > 0 || retrieval.semantic_hits > 0) &&
            t('chat.recall', { fts: retrieval.fts_hits, sem: retrieval.semantic_hits })}
          {retrieval.timing && (
            <>
              {t('chat.totalTime', { ms: retrieval.timing.total_ms })}
              {retrieval.timing.fts_ms > 0 && t('chat.ftsTime', { ms: retrieval.timing.fts_ms })}
              {retrieval.timing.embed_query_ms > 0 && t('chat.embedTime', { ms: retrieval.timing.embed_query_ms })}
              {retrieval.timing.semantic_ms > 0 && t('chat.vectorTime', { ms: retrieval.timing.semantic_ms })}
              {retrieval.timing.rerank_ms > 0 && t('chat.rerankTime', { ms: retrieval.timing.rerank_ms })}
            </>
          )}
        </div>
      )}

      <div className="divide-y divide-border/40">
        {groups.map((group) => {
          const expanded = expandedDocs.has(group.doc_id)
          const visible = expanded
            ? group.items
            : group.items.slice(0, CITATION_SNIPPET_PREVIEW)
          const hidden = group.items.length - visible.length
          return (
            <div key={group.doc_id} className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 min-w-0 mb-1.5">
                <Link
                  to={`/doc/${group.doc_id}`}
                  className="min-w-0 truncate text-[12.5px] font-medium text-foreground hover:text-primary transition-colors"
                >
                  {group.doc_title || t('chat.untitledDoc')}
                </Link>
                <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                  {t('chat.segments', { n: group.items.length })}
                </span>
                <Link
                  to={`/doc/${group.doc_id}`}
                  className="ml-auto shrink-0 p-0.5 text-muted-foreground/50 hover:text-primary transition-colors"
                  title={t('chat.openDoc')}
                  aria-label={t('chat.openDoc')}
                >
                  <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
                </Link>
              </div>
              <ol className="space-y-0.5">
                {visible.map((c, i) => (
                  <li key={c.block_id}>
                    <Link
                      to={`/doc/${c.doc_id}#block-${c.block_id}`}
                      className="flex gap-2 rounded-md px-1.5 py-1.5 -mx-0.5 text-[11.5px] text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors group/snip"
                      title={t('chat.jumpToBlock')}
                    >
                      <span className="shrink-0 w-4 text-right font-mono text-[10px] text-muted-foreground/55 group-hover/snip:text-primary/70 tabular-nums pt-px">
                        {i + 1}
                      </span>
                      <span className="min-w-0 line-clamp-2 leading-relaxed">{c.snippet}</span>
                    </Link>
                  </li>
                ))}
              </ol>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => toggleDoc(group.doc_id)}
                  className="mt-1 ml-5 text-[11px] text-primary/80 hover:text-primary transition-colors"
                >
                  {t('chat.expandMore', { n: hidden })}
                </button>
              )}
              {expanded && group.items.length > CITATION_SNIPPET_PREVIEW && (
                <button
                  type="button"
                  onClick={() => toggleDoc(group.doc_id)}
                  className="mt-1 ml-5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('chat.collapse')}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ThinkBlock({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  const { t } = useTranslation()
  // 默认折叠，且不做任何自动开合——思考期自动展开、正文到达自动收起的生命周期
  // 切换本身就是对话流中的一次高度跳变；展开与否完全交给用户
  const [open, setOpen] = useState(false)

  return (
    <div className="chat-think">
      <button
        type="button"
        className="chat-think-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Brain className="w-3 h-3 opacity-70" />
        <span>{streaming ? t('chat.thinking') : t('chat.thinkProcess')}</span>
        {streaming && <Loader2 className="w-3 h-3 animate-spin opacity-60" />}
      </button>
      {open && <div className="chat-think-body whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

/** 把写提案渲染为人类可读摘要 */
function proposalSummary(p: WriteProposal): { title: string; body: string } {
  if (p.tool === 'notefast_create_note') {
    const title = String(p.args.title ?? '')
    const md = String(p.args.markdown ?? '')
    return { title: i18next.t('chat.proposalCreate', { title }), body: md }
  }
  if (p.tool === 'notefast_append_to_doc') {
    const heading = String(p.args.heading ?? '')
    const content = String(p.args.content ?? '')
    return { title: i18next.t('chat.proposalAppend'), body: [heading, content].filter(Boolean).join('\n\n') }
  }
  // update_block
  return { title: i18next.t('chat.proposalUpdate'), body: String(p.args.content ?? '') }
}

function WriteProposalCard({
  proposal,
  onConfirm,
  onReject,
}: {
  proposal: WriteProposal
  onConfirm: () => void
  onReject: () => void
}) {
  const { t } = useTranslation()
  const { title, body } = proposalSummary(proposal)

  return (
    <div className="rounded-xl border border-primary/25 bg-primary-softer/60 p-3.5 space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className="w-6 h-6 rounded-md bg-primary/15 text-primary grid place-items-center shrink-0 mt-0.5">
          <Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{title}</p>
          {proposal.status === 'error' && proposal.error && (
            <p className="text-[12px] text-destructive mt-1">{proposal.error}</p>
          )}
          {proposal.status === 'pending' && (
            <pre className="mt-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap font-sans text-muted-foreground bg-background/60 border border-border/50 rounded-md p-2.5 max-h-36 overflow-y-auto">
              {body || t('chat.noPreview')}
            </pre>
          )}
        </div>
      </div>
      {proposal.status === 'pending' && (
        <div className="flex justify-end gap-2 pl-8">
          <button
            type="button"
            onClick={onReject}
            className="px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground bg-transparent hover:bg-secondary/60 rounded-md transition-colors"
          >
            {t('chat.reject')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary-hover transition-colors"
          >
            {t('chat.confirmWrite')}
          </button>
        </div>
      )}
      {proposal.status === 'executing' && (
        <div className="flex items-center gap-2 pl-8 text-[12px] text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          {t('chat.writing')}
        </div>
      )}
      {proposal.status === 'done' && (
        <p className="pl-8 text-[12px] text-muted-foreground">{t('chat.written')}</p>
      )}
      {proposal.status === 'dismissed' && (
        <p className="pl-8 text-[12px] text-muted-foreground">{t('chat.rejected')}</p>
      )}
    </div>
  )
}
