import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ListRowsSkeleton, useToast, Tooltip } from '../components/ui'
import { formatSqliteDateTime } from '../lib/time'

export interface DocRevision {
  kind: 'block' | 'snapshot'
  block_id: string
  rev: number
  content: string
  actor: string
  created_at: string
  /** 合成条目：当前文档最新状态，仅展示 diff、不可回退 */
  is_current?: boolean
}

export interface DiffLine { type: 'same' | 'added' | 'removed'; text: string }

function revisionKey(rev: DocRevision): string {
  return `${rev.block_id}#${rev.rev}`
}

/** 来源标签：actor → 可读文案（快照与块级都显示修改来源） */
function actorLabel(rev: DocRevision): string {
  switch (rev.actor) {
    case 'current': return i18next.t('doc.revisionActionCurrent')
    case 'revert': return i18next.t('doc.revisionActionRevert')
    case 'ai': return i18next.t('doc.revisionActionAi')
    case 'mcp': return i18next.t('doc.revisionActionMcp')
    case 'editor': return i18next.t('doc.revisionActionEditor')
    case 'user': return i18next.t('doc.revisionActionDirect')
    default: return rev.actor || i18next.t('doc.revisionActionEdit')
  }
}

/** 行级 diff（LCS）：对比两条 markdown，返回变化行（added=绿 / removed=红），用于历史快照对比 */
function lineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const m = aLines.length
  const n = bLines.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（从尾部递推，便于回溯）
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1]! + 1 : Math.max(dp[i + 1][j]!, dp[i][j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: 'same', text: aLines[i]! })
      i++; j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'removed', text: aLines[i]! })
      i++
    } else {
      out.push({ type: 'added', text: bLines[j]! })
      j++
    }
  }
  while (i < m) out.push({ type: 'removed', text: aLines[i++]! })
  while (j < n) out.push({ type: 'added', text: bLines[j++]! })
  return out
}

/** 折叠相同行（只显示变化及其上下文），控制展开体积 */
function summarizeDiff(lines: DiffLine[], context = 2): DiffLine[] {
  const changedIdx = new Set<number>()
  lines.forEach((l, idx) => {
    if (l.type !== 'same') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) changedIdx.add(k)
    }
  })
  return lines.filter((_, idx) => changedIdx.has(idx))
}

/** stale-while-revalidate 降透明的最短延迟：
 * fetch 在此窗口内完成则永远不显示降透明（避免 LAN 快请求下的幽灵闪烁）。
 * 经验值：本地/同机房 fetch 通常 20-60ms，留 120ms 留余量。 */


export function HistoryView({
  docId,
  revisions,
  loading,
  onRestored,
}: {
  docId: string
  revisions: DocRevision[]
  loading: boolean
  onRestored: () => void
}) {
  const toast = useToast()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [restoring, setRestoring] = useState<string | null>(null)

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleRestore = async (rev: DocRevision) => {
    const isSnapshot = rev.kind === 'snapshot'
    const ok = window.confirm(
      isSnapshot
        ? t('doc.confirmRevertSnapshot')
        : t('doc.confirmRevertBlock'),
    )
    if (!ok) return
    setRestoring(revisionKey(rev))
    try {
      if (isSnapshot) {
        // 整篇快照：走整篇替换端点（回退正文 + 标题，快照内容即完整 markdown）
        await api.post(`/docs/${docId}/snapshots/${rev.rev}/restore`, {})
      } else {
        await api.post(`/blocks/${rev.block_id}/revisions/${rev.rev}/restore`, {})
      }
      toast.success({ title: t('doc.reverted') })
      onRestored()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error({ title: t('doc.revertFailed'), description: msg })
    } finally {
      setRestoring(null)
    }
  }

  if (loading && revisions.length === 0) {
    return <ListRowsSkeleton rows={4} withIcon={false} />
  }
  if (revisions.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        {t('doc.noHistory')}
      </div>
    )
  }

  const snapshots = revisions.filter((r) => r.kind === 'snapshot')
  const blockEdits = revisions.filter((r) => r.kind === 'block')

  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-[11px] text-muted-foreground/60 leading-relaxed">
        {t('doc.historyDescription')}
      </p>

      {/* 整篇快照：文档级时间线 */}
      {snapshots.length > 0 && (
        <section>
          <h4 className="px-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.05em] text-muted-foreground/50">
            {t('doc.snapshotSection')}
          </h4>
          <div className="flex flex-col gap-1">
            {snapshots.map((rev, idx) => {
              // 与该快照「更旧的下一条」做 diff，突出本次改了什么（最新一条无更旧对照 → null）
              const prev = snapshots[idx + 1]
              const diff = prev ? lineDiff(prev.content, rev.content) : null
              return (
                <RevisionItem
                  key={revisionKey(rev)}
                  rev={rev}
                  label={actorLabel(rev)}
                  diff={diff ? summarizeDiff(diff) : null}
                  expanded={expanded}
                  restoring={restoring}
                  onToggle={toggle}
                  onRestore={handleRestore}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* 块级修改：单块历史 */}
      {blockEdits.length > 0 && (
        <section>
          <h4 className="px-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.05em] text-muted-foreground/50">
            {t('doc.blockEditSection')}
          </h4>
          <div className="flex flex-col gap-1">
            {blockEdits.map((rev) => (
              <RevisionItem
                key={revisionKey(rev)}
                rev={rev}
                label={actorLabel(rev)}
                expanded={expanded}
                restoring={restoring}
                onToggle={toggle}
                onRestore={handleRestore}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export function RevisionItem({
  rev,
  label,
  diff,
  expanded,
  restoring,
  onToggle,
  onRestore,
}: {
  rev: DocRevision
  label: string
  /** 整篇快照的变更 diff（相对更旧快照）；null = 无对照（最新）或非快照 */
  diff?: DiffLine[] | null
  expanded: ReadonlySet<string>
  restoring: string | null
  onToggle: (key: string) => void
  onRestore: (rev: DocRevision) => void
}) {
  const key = revisionKey(rev)
  const isOpen = expanded.has(key)
  const { t } = useTranslation()
  return (
    <div className="group rounded-lg border border-border/50 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block text-[11.5px] text-muted-foreground truncate">{label}</span>
          <span className="block text-[10.5px] text-muted-foreground/60 tabular-nums">
            {formatSqliteDateTime(rev.created_at)}
          </span>
        </button>
        <Tooltip label={isOpen ? t('doc.collapse') : t('doc.preview')}>
          <button
            type="button"
            onClick={() => onToggle(key)}
            className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
            aria-label={isOpen ? t('doc.collapse') : t('doc.preview')}
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </Tooltip>
        {!rev.is_current && (
          <button
            type="button"
            disabled={restoring === key}
            onClick={() => onRestore(rev)}
            className="shrink-0 px-1.5 py-1 text-[11px] font-medium text-primary/80 hover:text-primary disabled:opacity-50 transition-colors"
          >
            {restoring === key ? '…' : t('doc.revert')}
          </button>
        )}
      </div>
      {isOpen && (
        diff && diff.length > 0 ? (
          <div className="px-3 py-2 border-t border-border/40 text-[11px] leading-relaxed font-mono max-h-40 overflow-y-auto">
            {diff.map((l, i) => (
              <div
                key={i}
                className={l.type === 'added'
                  ? 'text-success bg-success-soft px-1 -mx-1'
                  : l.type === 'removed'
                    ? 'text-destructive bg-destructive-soft px-1 -mx-1'
                    : 'text-muted-foreground/60'}
              >
                {l.type === 'added' ? '+ ' : l.type === 'removed' ? '− ' : '  '}
                {l.text || '⏎'}
              </div>
            ))}
          </div>
        ) : (
          <pre className="px-3 py-2 border-t border-border/40 text-[11px] leading-relaxed whitespace-pre-wrap font-sans text-muted-foreground bg-background/40 max-h-40 overflow-y-auto">
            {rev.content || t('doc.emptyContent')}
          </pre>
        )
      )}
    </div>
  )
}
