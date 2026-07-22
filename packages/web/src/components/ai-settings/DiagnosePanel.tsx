import { CheckCircle2, AlertCircle } from 'lucide-react'
import type { AiDiagnoseResult } from '@notefast/core'

type DiagR = {
  configured: boolean
  ok?: boolean
  latencyMs?: number
  message?: string
  error?: string
  dim?: number
  hitCount?: number
  replySample?: string
  model?: string
  embeddingCalls?: number
  prerequisites?: { chat: { configured: boolean; ok: boolean }; embedding: unknown }
  autoApply?: 'never' | 'high_confidence'
}

/** 一键诊断结果面板：overall 状态点 + 各能力逐行结果（Embedding / Chat / Reranker / AutoLink） */
export function DiagnosePanel({ result, onClose }: { result: AiDiagnoseResult; onClose: () => void }) {
  return (
    <div className="text-xs rounded-md bg-muted/40 border border-border overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background/40">
        <div className="flex items-center gap-2">
          <OverallDot overall={result.overall} />
          <span className="font-medium text-foreground">
            {result.overall === 'healthy'
              ? '一切正常'
              : result.overall === 'partial'
                ? '部分能力可用'
                : result.overall === 'degraded'
                  ? '已配置但都不可达'
                  : '尚未启用任何 AI 能力'}
          </span>
          {result.elapsedMs != null && (
            <span className="text-[10px] text-muted-foreground/70 font-mono">
              {result.elapsedMs} ms
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          关闭
        </button>
      </div>
      <div className="divide-y divide-border/60">
        <DiagRow icon="↻" label="Embedding" r={result.embedding} />
        <DiagRow icon="✦" label="Chat" r={result.chat} />
        <DiagRow icon="⊕" label="Reranker" r={result.reranker} />
        {result.autoLink?.configured && (
          <DiagRow icon="⌘" label="AutoLink" r={result.autoLink} autoLink />
        )}
      </div>
    </div>
  )
}

function OverallDot({ overall }: { overall: AiDiagnoseResult['overall'] }) {
  const tone =
    overall === 'healthy'
      ? 'bg-emerald-500'
      : overall === 'partial'
        ? 'bg-amber-500'
        : overall === 'degraded'
          ? 'bg-destructive'
          : 'bg-border'
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${tone}`} aria-label={overall} />
  )
}

function DiagRow({
  icon,
  label,
  r,
  autoLink,
}: {
  icon: string
  label: string
  r: DiagR
  autoLink?: boolean
}) {
  if (!r.configured) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 text-muted-foreground/70">
        <span className="w-5 text-center text-foreground/60 text-[13px]">{icon}</span>
        <span className="w-16 font-medium text-foreground/80">{label}</span>
        <span className="text-[11px] italic">未配置</span>
      </div>
    )
  }

  const ok = r.ok === true
  const detail = autoLink
    ? autoLinkFormat(r)
    : r.error
      ? `× ${truncateError(r.error)}`
      : r.message
        ? r.message
        : ''
  const meta = describeMeta(r)

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-5 text-center text-foreground/60 text-[13px]">{icon}</span>
      <span className="w-16 font-medium text-foreground">{label}</span>
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
      )}
      <span className={`flex-1 truncate ${ok ? 'text-foreground/85' : 'text-destructive'}`}>
        {detail}
      </span>
      <span className="text-[10px] text-muted-foreground/65 font-mono shrink-0">{meta}</span>
    </div>
  )
}

function autoLinkFormat(r: DiagR): string {
  const prereq = r.prerequisites?.chat
  if (!prereq) return ''
  if (!prereq.configured) return '需要 Chat 模型已配置'
  if (!prereq.ok) return '依赖 Chat 不可达，建议不会触发'
  return r.autoApply === 'high_confidence'
    ? '依赖 Chat 已通（高置信自动应用）'
    : '依赖 Chat 已通（仅建议）'
}

function describeMeta(r: DiagR): string {
  const parts: string[] = []
  if (r.latencyMs != null) parts.push(`${r.latencyMs} ms`)
  if (r.dim != null) parts.push(`dim=${r.dim}`)
  if (r.hitCount != null) parts.push(`${r.hitCount} hits`)
  return parts.join(' · ')
}

function truncateError(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
