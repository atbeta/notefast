import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { RotateCcw, Check, X, RefreshCw, CheckCheck, Trash2 } from 'lucide-react'
import type { AutolinkSuggestionWire } from '@notefast/core'
import { api } from '../hooks/useAPI'
import ConfirmDialog from '../components/ConfirmDialog'

type FilterStatus = 'unreviewed' | 'accepted' | 'dismissed' | 'all'

export default function AutolinkPage() {
  const [items, setItems] = useState<AutolinkSuggestionWire[]>([])
  const [filter, setFilter] = useState<FilterStatus>('unreviewed')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState<'accept' | 'dismiss' | null>(null)
  const [showAcceptAll, setShowAcceptAll] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get<{ count: number; items: AutolinkSuggestionWire[] }>(`/auto-link/inbox?status=${filter}&limit=200`)
      setItems(r.items)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    refresh()
  }, [refresh])

  const withBusy = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusy((prev) => new Set(prev).add(id))
    try { await fn() } finally {
      setBusy((prev) => {
        const next = new Set(prev); next.delete(id); return next
      })
    }
  }, [])

  const accept = (id: string) => withBusy(id, async () => {
    await api.post(`/auto-link/apply`, { suggestion_id: id })
    await refresh()
  })

  const dismiss = (id: string) => withBusy(id, async () => {
    await api.post(`/auto-link/dismiss`, { suggestion_id: id })
    await refresh()
  })

  const revert = (id: string) => withBusy(id, async () => {
    await api.post(`/auto-link/${id}/revert`, {})
    await refresh()
  })

  /** 当前列表里可批量处理的条目（未审阅 + 仅建议状态） */
  const actionableIds = items
    .filter((it) => it.review_status === 'unreviewed' && it.action_status === 'suggested')
    .map((it) => it.id)

  const bulkReview = async (action: 'accept' | 'dismiss') => {
    if (actionableIds.length === 0 || bulkBusy) return
    setBulkBusy(action)
    try {
      await api.post('/auto-link/bulk-review', { action, ids: actionableIds })
      await refresh()
    } finally {
      setBulkBusy(null)
      setShowAcceptAll(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="h-14 shrink-0 px-6 border-b border-border/50 flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-[-0.01em]">链接建议</h1>
        <span className="text-xs text-muted-foreground/70">
          待处理的链接建议；已应用的在「已接受」
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-muted-foreground hover:text-foreground hover:border-foreground/15 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            刷新
          </button>
        </div>
      </div>

      <div className="px-6 pt-3 pb-2 border-b border-border/50 flex items-center gap-2 text-[12px]">
        {(['unreviewed', 'accepted', 'dismissed', 'all'] as FilterStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              filter === s
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {s === 'unreviewed' ? '未审阅' : s === 'accepted' ? '已接受' : s === 'dismissed' ? '已忽略' : '全部'}
          </button>
        ))}
        {actionableIds.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowAcceptAll(true)}
              disabled={bulkBusy !== null}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.75} />
              全部接受 ({actionableIds.length})
            </button>
            <button
              type="button"
              onClick={() => bulkReview('dismiss')}
              disabled={bulkBusy !== null}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              {bulkBusy === 'dismiss' ? '处理中…' : '全部忽略'}
            </button>
          </span>
        )}
        <span className={`text-muted-foreground/60 tabular-nums ${actionableIds.length > 0 ? '' : 'ml-auto'}`}>
          {items.length} 条
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-4">
        {loading && items.length === 0 ? (
          <div className="text-center text-muted-foreground/60 text-sm py-12">加载中…</div>
        ) : items.length === 0 ? (
          <div className="text-center text-muted-foreground/60 text-sm py-12">
            {filter === 'unreviewed' ? '没有待审阅的 AI 活动。' : '无匹配项。'}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto divide-y divide-border/50">
            {items.map((it) => (
              <AutolinkRow
                key={it.id}
                item={it}
                busy={busy.has(it.id)}
                onAccept={() => accept(it.id)}
                onDismiss={() => dismiss(it.id)}
                onRevert={() => revert(it.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showAcceptAll}
        title="全部接受"
        message={`将把当前列表中 ${actionableIds.length} 条建议全部写入反向链接。此操作会批量修改文档内容，确定继续吗？`}
        confirmLabel={bulkBusy === 'accept' ? '处理中…' : `接受 ${actionableIds.length} 条`}
        onConfirm={() => bulkReview('accept')}
        onCancel={() => setShowAcceptAll(false)}
      />
    </div>
  )
}

function AutolinkRow({
  item,
  busy,
  onAccept,
  onDismiss,
  onRevert,
}: {
  item: AutolinkSuggestionWire
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
  onRevert: () => void
}) {
  const top = item.candidates[0]
  return (
    <div className="py-4 px-2 -mx-2 first:pt-2 rounded-md hover:bg-accent/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs mb-1.5">
            <StatusBadge action={item.action_status} />
            {item.action_status === 'applied' && item.applied_target_id && (
              <span className="text-muted-foreground/70">
                → 已写入 ref #{item.created_ref_id}
              </span>
            )}
            {item.error && (
              <span className="text-red-600/80">⚠ {item.error}</span>
            )}
            <span className="ml-auto text-muted-foreground/55 tabular-nums">
              {new Date(item.created_at).toLocaleString('zh-CN', { hour12: false })}
            </span>
          </div>

          {item.source_doc_id ? (
            <Link
              to={`/doc/${item.source_doc_id}#block-${item.source_block_id}`}
              className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              {item.source_doc_title} →
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground/55">{item.source_doc_title || '（源文档已删除）'}</span>
          )}
          <div className="mt-1 text-[13px] text-foreground/90 line-clamp-2">
            {item.source_content || '（无预览）'}
          </div>

          <div className="mt-2 text-[11px] text-muted-foreground/60 flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded bg-muted text-foreground/70 font-mono">{item.anchor}</span>
            <span className="uppercase tracking-wider">{item.kind}</span>
            <span>· score_kind={item.score_kind}</span>
            {top && <span>· top-1 conf={top.confidence.toFixed(2)}</span>}
          </div>

          {item.candidates.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {item.candidates.slice(0, 3).map((c, i) => (
                <div
                  key={c.block_id + i}
                  className="text-[12px] text-muted-foreground border-l-2 border-border pl-2.5 py-1"
                >
                  <div className="text-foreground/80 truncate">
                    <span className="text-muted-foreground/55 mr-1.5">[{i}]</span>
                    {c.doc_title || '(未命名文档)'}
                  </div>
                  <div className="text-muted-foreground/70 truncate mt-0.5">
                    {c.snippet}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0 w-[76px]">
          {item.action_status === 'suggested' && (
            <>
              <button
                type="button"
                onClick={onAccept}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1 w-full px-2.5 py-1 rounded-md border border-border text-foreground text-[12px] hover:bg-accent disabled:opacity-50 transition-colors"
              >
                <Check className="w-3 h-3" strokeWidth={2.5} />
                接受
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1 w-full px-2.5 py-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
              >
                <X className="w-3 h-3" strokeWidth={2.5} />
                忽略
              </button>
            </>
          )}
          {item.action_status === 'applied' && (
            <button
              type="button"
              onClick={onRevert}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1 w-full px-2.5 py-1 rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[12px] hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
              title="按 created_ref_id 精确撤销，不影响其他 ref"
            >
              <RotateCcw className="w-3 h-3" strokeWidth={2} />
              撤销
            </button>
          )}
          {item.action_status === 'reverted' && (
            <span className="text-[11px] text-muted-foreground/60 italic">已撤销（可重新接受）</span>
          )}
          {item.action_status === 'failed' && (
            <span className="text-[11px] text-red-600/80 italic">失败 · 已跳过</span>
          )}
          {item.action_status === 'superseded' && (
            <span className="text-[11px] text-muted-foreground/50 italic">已过期</span>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ action }: { action: AutolinkSuggestionWire['action_status'] }) {
  const map: Record<AutolinkSuggestionWire['action_status'], { label: string; cls: string }> = {
    suggested: { label: '建议', cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
    applied: { label: '已应用', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
    reverted: { label: '已撤销', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    failed: { label: '失败', cls: 'bg-red-500/15 text-red-700 dark:text-red-300' },
    superseded: { label: '已过期', cls: 'bg-muted text-muted-foreground' },
  }
  const m = map[action]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  )
}
