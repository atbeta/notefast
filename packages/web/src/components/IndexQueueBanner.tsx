/**
 * 全局增量索引队列条：导入很多文档时始终能看到「在跑 / 已暂停」，并可暂停、继续。
 * 设置页 AI 面板有同样的控制；本条在 /settings/ai 上隐藏以免重复。
 */

import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Pause, Play } from 'lucide-react'
import {
  pauseIndexQueue,
  resumeIndexQueue,
  useIndexJobSummary,
} from '../hooks/useIndexJob'

export function IndexQueueBanner() {
  const { t } = useTranslation()
  const location = useLocation()
  const { summary, setSummary } = useIndexJobSummary()
  const [acting, setActing] = useState(false)

  if (location.pathname.startsWith('/settings/ai')) return null
  if (!summary) return null

  const busy = summary.running > 0 || summary.pending > 0
  if (!busy && !summary.paused) return null

  const active = summary.active
  const label = summary.paused
    ? t('indexQueue.paused', { pending: summary.pending })
    : active
      ? t('indexQueue.indexingActive', {
          done: active.done + active.skipped,
          total: active.total_blocks,
          pending: summary.pending,
        })
      : t('indexQueue.indexing', { pending: summary.pending })

  const toggle = async () => {
    if (acting) return
    setActing(true)
    try {
      const next = summary.paused ? await resumeIndexQueue() : await pauseIndexQueue()
      setSummary(next)
    } catch {
      /* 下一次轮询会校正 */
    } finally {
      setActing(false)
    }
  }

  return (
    <div
      role="status"
      className="w-full print:hidden bg-muted/50 border-b border-border/70 px-4 py-1.5 text-sm text-muted-foreground flex items-center gap-3"
    >
      {summary.paused ? (
        <Pause className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
      ) : (
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" strokeWidth={1.75} />
      )}
      <span className="flex-1 min-w-0 truncate tabular-nums">{label}</span>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={acting}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-border hover:bg-accent transition-colors text-xs text-foreground disabled:opacity-50"
      >
        {summary.paused ? (
          <>
            <Play className="w-3 h-3" strokeWidth={1.75} />
            {t('indexQueue.resume')}
          </>
        ) : (
          <>
            <Pause className="w-3 h-3" strokeWidth={1.75} />
            {t('indexQueue.pause')}
          </>
        )}
      </button>
      <Link
        to="/settings/ai"
        className="shrink-0 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        {t('indexQueue.openSettings')}
      </Link>
    </div>
  )
}
