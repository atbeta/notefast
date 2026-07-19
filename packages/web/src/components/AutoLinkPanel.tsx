import { useState, useEffect, useCallback } from 'react'
import { Check, X, Loader2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { api } from '../hooks/useAPI'

interface AutoLinkCandidate {
  block_id: string
  doc_id: string
  doc_title: string
  snippet: string
  confidence: number
}

interface AutoLinkSuggestion {
  id: string
  source_block_id: string
  anchor: string
  kind: string
  candidates: AutoLinkCandidate[]
  created_at: string
}

interface AutoLinkPanelProps {
  docId: string | null
  /** 当前用户查看的 block（用于按 block 过滤） */
  currentBlockId?: string | null
  /** 关闭按钮回调（保留兼容，当前 UI 不再渲染关闭按钮） */
  onClose?: () => void
}

const KIND_COLORS: Record<string, string> = {
  concept: 'bg-blue-500/10 text-blue-600 dark:text-blue-300 border-blue-500/30',
  tool: 'bg-purple-500/10 text-purple-600 dark:text-purple-300 border-purple-500/30',
  person: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30',
  doc: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
}

export default function AutoLinkPanel({ docId, currentBlockId }: AutoLinkPanelProps) {
  const [suggestions, setSuggestions] = useState<AutoLinkSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [triggering, setTriggering] = useState(false)

  const fetchSuggestions = useCallback(async () => {
    if (!docId) return
    setLoading(true)
    try {
      const res = await api.get<{ suggestions: AutoLinkSuggestion[]; count: number }>(
        `/auto-link/suggestions?doc_id=${docId}`,
      )
      setSuggestions(res.suggestions || [])
    } catch {
      setSuggestions([])
    } finally {
      setLoading(false)
    }
  }, [docId])

  useEffect(() => {
    fetchSuggestions()
  }, [fetchSuggestions])

  const handleAccept = async (sid: string) => {
    setBusyId(sid)
    try {
      await api.post(`/auto-link/apply`, { suggestion_id: sid })
      setSuggestions((prev) => prev.filter((s) => s.id !== sid))
    } finally {
      setBusyId(null)
    }
  }

  const handleDismiss = async (sid: string) => {
    setBusyId(sid)
    try {
      await api.post(`/auto-link/dismiss`, { suggestion_id: sid })
      setSuggestions((prev) => prev.filter((s) => s.id !== sid))
    } finally {
      setBusyId(null)
    }
  }

  const handleRunBatch = async () => {
    if (!docId) return
    setTriggering(true)
    try {
      await api.post(`/auto-link/run-batch`, { doc_id: docId })
      await fetchSuggestions()
    } finally {
      setTriggering(false)
    }
  }

  const visible = currentBlockId
    ? suggestions.filter((s) => s.source_block_id === currentBlockId)
    : suggestions

  if (!docId) return null

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground transition-colors select-none"
        >
          <span className="w-3 h-px bg-border-strong" />
          <span>链接建议</span>
          {visible.length > 0 && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-primary/10 text-primary tabular-nums">
              {visible.length}
            </span>
          )}
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleRunBatch}
            disabled={triggering}
            className="p-1 text-muted-foreground/70 hover:text-foreground rounded transition-colors disabled:opacity-50"
            title="重新分析此文档所有 block"
          >
            {triggering ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="p-1 text-muted-foreground/70 hover:text-foreground rounded transition-colors"
            title={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.75} /> : <ChevronUp className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-2">
          {loading && (
            <div className="text-[12px] text-muted-foreground/70 py-3 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              加载中…
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="text-[12px] text-muted-foreground/60 leading-relaxed">
              暂无建议 · 启用 AutoLink 后，新写或修改 block 时会建议反向链接。
            </div>
          )}
          {visible.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              busy={busyId === s.id}
              onAccept={handleAccept}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SuggestionCard({
  suggestion,
  busy,
  onAccept,
  onDismiss,
}: {
  suggestion: AutoLinkSuggestion
  busy: boolean
  onAccept: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const candidate = suggestion.candidates[selectedIdx]
  const kindClass = KIND_COLORS[suggestion.kind] || KIND_COLORS.concept

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">「{suggestion.anchor}」</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${kindClass}`}>{suggestion.kind}</span>
      </div>

      {suggestion.candidates.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">链接到</div>
          {suggestion.candidates.map((c, i) => (
            <button
              key={c.block_id}
              type="button"
              onClick={() => setSelectedIdx(i)}
              className={`block w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                i === selectedIdx
                  ? 'bg-primary/10 text-foreground ring-1 ring-primary/30'
                  : 'hover:bg-accent text-muted-foreground'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{c.doc_title}</span>
                <span className="text-[10px] text-muted-foreground/70 shrink-0 ml-2">
                  {(c.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <div className="text-[11px] line-clamp-1 mt-0.5 opacity-80">{c.snippet}</div>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => onAccept(suggestion.id)}
          disabled={busy || !candidate}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-ink text-ink-foreground hover:bg-ink-hover active:scale-[0.97] disabled:opacity-40 transition-all"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          应用
        </button>
        <button
          type="button"
          onClick={() => onDismiss(suggestion.id)}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 transition-colors"
        >
          <X className="w-3 h-3" />
          忽略
        </button>
        {candidate && (
          <span className="ml-auto text-[10px] text-muted-foreground/60 font-mono truncate">
            {candidate.block_id.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  )
}
