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
import { request } from '../hooks/useAPI'
import { useAiCapabilities, refreshAiCapabilities } from '../hooks/useAiCapabilities'
import { streamSSE, type SSEError } from '../lib/streaming'
import { useScrollFade } from '../hooks/useScrollFade'
import { isTauriShell } from '../hooks/useShell'
import { ASK_AI_EVENT, type AskAiDetail } from '../lib/askAi'
import ChatMarkdown from './ChatMarkdown'
import CitationSources, { type Citation, type CitationGroup, type RetrievalInfo } from './CitationSources'
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
  const [configMissing, setConfigMissing] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [skills, setSkills] = useState<AiSkill[]>([])
  const capabilities = useAiCapabilities()
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

  // 自动跟随到底：仅当滚动容器本就近底部时才滚动（用户上翻阅读历史时不强制拉回）；
  // 用 auto 而非 smooth —— 流式期间每 token 触发一次，smooth 会反复重启动画造成抖动
  useEffect(() => {
    const container = messagesFadeRef.current
    const end = messagesEndRef.current
    if (!container || !end) return
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceToBottom < 80) end.scrollIntoView({ behavior: 'auto' })
  }, [messages, toolStatus])

  // 拉取能力：订阅单例（useAiCapabilities），打开面板时强制重探测一次
  // （设置页改配置后重新打开能拿到新值；探测失败按全 false = 未配置处理）
  useEffect(() => {
    if (!isOpen) return
    refreshAiCapabilities()
    if (capabilities.ready && !capabilities.chat) setConfigMissing(true)
    if (capabilities.ready && capabilities.chat) setConfigMissing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, capabilities.ready, capabilities.chat])

  // 内置技能（整理收集箱 / 归档建议 / 周期回顾）：点击填入输入框，用户可改再发
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    request<{ skills: AiSkill[] }>('/ai/skills')
      .then((r) => { if (!cancelled) setSkills(r.skills) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isOpen])

  /** 打开时自动聚焦输入框：避免键入落到背景文档编辑器，并解决首键丢失。
   *  delay 让 slide-in 动画开始后再聚焦。仅在 isOpen 翻转时跑一次（附件后加不重跑）。 */
  useEffect(() => {
    if (!isOpen) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 200)
    return () => window.clearTimeout(id)
  }, [isOpen])

  // 阅读态块菜单「问 AI 关于这一段」：预填引用草稿（不自动发送，用户审阅后自行发出）
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<AskAiDetail>).detail
      if (!detail?.quote) return
      const quoted = detail.quote.split('\n').map((l) => `> ${l}`).join('\n')
      setInput(`${t('chat.askAboutPrefix')}\n${quoted}\n\n`)
      window.setTimeout(() => inputRef.current?.focus(), 60)
    }
    window.addEventListener(ASK_AI_EVENT, onAsk)
    return () => window.removeEventListener(ASK_AI_EVENT, onAsk)
  }, [t])

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [])

  /** 同源引用合并：一份文档被引多个 block 时只列一次标题，片段以紧凑子列表收纳。
   *  每个 item 保留全局引用序号（citations 数组位置 + 1）——正文 [n] 按此编号，
   *  来源列表必须同源，不能按文档分组后从 1 重排。 */
  const groupedCitations = useMemo(() => {
    const map = new Map<string, CitationGroup>()
    citations.forEach((c, i) => {
      const existing = map.get(c.doc_id)
      const item = { ...c, ref: i + 1 }
      if (existing) {
        existing.items.push(item)
      } else {
        map.set(c.doc_id, { doc_id: c.doc_id, doc_title: c.doc_title, items: [item] })
      }
    })
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

    let assistantText = ''
    let reasoningText = ''

    // 流式消费统一走 lib/streaming 的 streamSSE（与 useAiWriting 同一实现）：
    // error 帧在流内抛错并透传服务端 code 到 onError；用户停止走 onAbort 静默收尾
    let streamErr: SSEError | null = null
    let aborted = false
    await new Promise<void>((resolve) => {
      abortRef.current = streamSSE(
        '/ai/chat',
        {
          messages: outgoing,
          context_doc_id: contextDocId,
          top_k: 5,
        },
        {
          onEvent: (eventName, data) => {
            const payload = data as {
              retrieval?: RetrievalInfo
              citations?: Citation[]
              tool?: string
              content?: string
            }
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
            }
          },
          onError: (err) => {
            streamErr = err
            resolve()
          },
          onDone: () => resolve(),
          onAbort: () => {
            aborted = true
            resolve()
          },
        },
      )
    })

    if (aborted) {
      // 用户停止：保留已生成内容，不显示错误
    } else if (streamErr) {
      const err: SSEError = streamErr
      setMessages((prev) => [...prev, { role: 'assistant', content: t('chat.requestFailed', { msg: err.message }) }])
      // 未配置：code 是稳定判据（HTTP 错误体与流内 error 帧均由 streamSSE 透传）
      if (err.code === 'not_configured') {
        setConfigMissing(true)
      }
    } else if (assistantText || reasoningText) {
      // 确保最后一条 assistant 始终存在
      upsertAssistant({
        content: assistantText,
        reasoning: reasoningText || undefined,
      })
    }
    setLoading(false)
    setToolStatus(null)
    abortRef.current = null
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
  }

  const showSpinner = loading && !messages.some((m) => m.role === 'assistant' && (m.content.trim() || m.reasoning))

  // Tauri 壳下有自绘标题栏（h-9）——面板下移避开，否则会盖住窗口控制按钮
  const shellTop = isTauriShell() ? 'top-9 h-[calc(100vh-2.25rem)]' : 'top-0 h-screen'

  return (
    <>
      {/* 移动端遮罩：全宽面板覆盖整屏，半透明遮罩提示「面板模式下」的边界。
       *  桌面端（>=md）右栏只占 400/600px，遮罩会干扰阅读文档，不显示。 */}
      <div
        aria-hidden="true"
        onClick={() => onClose()}
        className={`fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] md:hidden transition-opacity duration-[var(--dur)] ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
      <div
        aria-hidden={!isOpen}
        onKeyDown={(e) => {
          // 桌面端面板内 Esc 关闭；清空确认打开时由 ConfirmDialog 处理，勿连带关面板
          if (e.key !== 'Escape' || !isOpen || showClearConfirm) return
          if (!window.matchMedia('(min-width: 768px)').matches) return
          e.stopPropagation()
          onClose()
        }}
        className={`fixed right-0 ${shellTop} bg-card border-l border-border shadow-[var(--shadow-floating)] z-40 flex flex-col
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
          <Tooltip label={contextDocId ? t('chat.contextDocTitle') : t('chat.contextAllTitle')}>
            <span className="shrink-0 text-[10.5px] font-medium px-1.5 py-px rounded border border-primary/25 bg-primary-soft text-primary/90">
              {contextDocId ? t('chat.contextDoc') : t('chat.contextAll')}
            </span>
          </Tooltip>
          <span className="flex items-center gap-1 text-muted-foreground shrink-0">
            {capabilities.embedding && (
              <Tooltip label={t('chat.embeddingConfigured')}>
                <span>
                  <Binary className="w-3 h-3" strokeWidth={1.75} aria-label={t('chat.embeddingConfigured')} />
                </span>
              </Tooltip>
            )}
            {capabilities.reranker && (
              <Tooltip label={t('chat.rerankConfigured')}>
                <span>
                  <ArrowUpDown className="w-3 h-3" strokeWidth={1.75} aria-label={t('chat.rerankConfigured')} />
                </span>
              </Tooltip>
            )}
          </span>
          {messages.length > 0 && (
            <>
              <span className="text-border shrink-0">|</span>
              <Tooltip label={t('chat.clearTitle')}>
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0"
                >
                  {t('chat.clear')}
                </button>
              </Tooltip>
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

      {/* Messages：padding 放内层，避免空态 h/min-h-full + 外层 p-4 把滚动高度撑出视口 */}
      <div ref={messagesFadeRef} className="scroll-fade flex-1 min-h-0 overflow-y-auto">
        {configMissing ? (
          <div className="flex flex-col items-center justify-center min-h-full p-4 text-center text-muted-foreground space-y-3">
            <MessageSquareText className="w-7 h-7 mb-1 opacity-50" strokeWidth={1.25} />
            <p className="text-sm">{t('chat.notConfigured')}</p>
            <p className="text-xs max-w-[260px]">{t('chat.notConfiguredDesc1')}</p>
            <Link
              to="/settings/ai"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('chat.openSettings')} <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col min-h-full p-4 pt-6 pb-5">
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
              <div className="grid gap-2 content-start">
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
          <div className="p-4 space-y-6">
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
                    {/* 用户 = 人形（中性灰）；AI = Sparkles（与全局 AI 入口同标识 + 品牌色） */}
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
        )}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-border bg-background">
        {/* 有对话时保留技能 chip；空态已用任务卡片展示，避免重复 */}
        {skills.length > 0 && !configMissing && messages.length > 0 && (
          <div className="flex gap-1.5 mb-2 overflow-x-auto pb-0.5">
            {skills.map((s) => {
              const SkillIcon = SKILL_ICONS[s.icon] ?? MessageSquareText
              return (
                <Tooltip key={s.id} label={s.description}>
                  <button
                    type="button"
                    onClick={() => {
                      setInput(s.prompt)
                      inputRef.current?.focus()
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-primary/20 bg-primary-softer text-[11px] text-primary hover:border-primary/40 hover:bg-primary-soft transition-colors whitespace-nowrap shrink-0"
                  >
                    <SkillIcon className="w-3 h-3" strokeWidth={1.75} />
                    {s.name}
                  </button>
                </Tooltip>
              )
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative group">
                <img src={a.dataUrl} alt={a.name} className="h-14 w-14 rounded-md border border-border/60 object-cover" />
                <Tooltip label={t('chat.removeAttachment')}>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-ink-foreground text-[10px] leading-none flex items-center justify-center opacity-80 hover:opacity-100"
                    aria-label={t('chat.removeAttachment')}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="relative flex items-end gap-2 bg-card border border-border rounded-xl shadow-sm focus-within:border-primary/50 transition-colors p-2"
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
            data-no-focus-ring
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
        tone="destructive"
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={() => {
          setShowClearConfirm(false)
          handleClear()
        }}
      />
    </div>
    </>
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
