/**
 * 回收站（Trash）— 软删除文档的恢复入口
 *
 * 删除是软删除（tombstone）：内容仍在库中，恢复整子树回到「所有文档」。
 * 两个不可恢复的副作用（既定语义，在描述里明示）：
 * - 分享旧链接永久失效（重开是新 token）
 * - 实体提及/链接由恢复路径自动重抽（reanalyzeDoc），非即时完成
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { formatRelative } from '../lib/time'
import PageHeader from '../components/PageHeader'
import { ListRowsSkeleton } from '../components/ui'

interface TrashItem {
  id: string
  title: string
  deleted_at: string
}

export default function TrashPage() {
  const { t } = useTranslation()
  const [busyId, setBusyId] = useState<string | null>(null)

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<TrashItem[]>('/docs/trash'),
    [],
  )
  // 外部通道（MCP / AI 聊天）删除或恢复时即时刷新
  useDocChanges(() => refetch())
  const docs = error ? [] : (data ?? [])

  const restore = async (id: string) => {
    setBusyId(id)
    try {
      await api.post(`/blocks/${id}/restore`, {})
      refetch()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            {t('trash.title')}
          </h1>
          {!loading && docs.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          {t('trash.description')}
        </p>

        {loading ? (
          <ListRowsSkeleton rows={4} />
        ) : docs.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Trash2 className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">{t('trash.emptyTitle')}</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
              {t('trash.emptyDesc')}
            </p>
          </div>
        ) : (
          <div className="grid gap-0.5">
            {docs.map((doc) => (
              <div key={doc.id} className="card-interactive px-3 py-2 group flex items-center gap-3">
                <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-[14px] text-foreground tracking-[-0.005em] truncate leading-snug">
                    {doc.title || t('common.unnamed')}
                  </h3>
                  <p className="text-[11.5px] text-muted-foreground mt-0.5 font-mono tabular-nums">
                    {t('trash.deletedAt', { time: formatRelative(doc.deleted_at) })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === doc.id}
                  onClick={() => restore(doc.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 shrink-0"
                  title={t('trash.restoreTitle')}
                >
                  {busyId === doc.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.75} />
                  )}
                  {t('trash.restore')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
