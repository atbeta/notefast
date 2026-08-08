/**
 * 资源库 — 本地图片等媒体的浏览入口（v1：只读列表）
 *
 * 图片始终本地存储（asset:<sha>）；图床外链是可选增强，在卡片上用状态标出。
 * 插入到文档、批量 GC 等留待后续；设置页仍管图床命令配置。
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Cloud, ImageIcon, Link2Off } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatRelative } from '../lib/time'
import PageHeader from '../components/PageHeader'
import { ListRowsSkeleton } from '../components/ui'

interface AssetListItem {
  id: string
  mime: string
  size: number
  created_at: string
  remote: boolean
  referenced: boolean
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function ResourcesPage() {
  const { t } = useTranslation()
  const { data, loading, error } = useApiQuery(
    () => api.get<{ items: AssetListItem[]; total: number }>('/assets?limit=200'),
    [],
  )
  const items = error ? [] : (data?.items ?? [])
  const total = data?.total ?? 0

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            {t('resources.title')}
          </h1>
          {!loading && total > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {total}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          {t('resources.description')}
        </p>

        {loading && !data ? (
          <ListRowsSkeleton rows={6} />
        ) : items.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <ImageIcon className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">{t('resources.emptyTitle')}</h3>
            <p className="text-[13px] text-muted-foreground max-w-sm leading-relaxed">
              {t('resources.emptyDesc')}
            </p>
            <Link
              to="/settings/images"
              className="inline-block mt-3 text-[13px] text-primary hover:underline"
            >
              {t('resources.openImageSettings')}
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-border/60 bg-card overflow-hidden shadow-[var(--shadow-card)]"
              >
                <div className="aspect-square bg-muted/40 flex items-center justify-center overflow-hidden">
                  <img
                    src={`/api/v1/assets/${item.id}`}
                    alt=""
                    loading="lazy"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
                <div className="px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    {item.remote ? (
                      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <Cloud className="w-3 h-3" strokeWidth={1.75} />
                        {t('resources.remote')}
                      </span>
                    ) : (
                      <span>{t('resources.local')}</span>
                    )}
                    <span className="text-muted-foreground/40">·</span>
                    {item.referenced ? (
                      <span>{t('resources.inUse')}</span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 text-muted-foreground/70">
                        <Link2Off className="w-3 h-3" strokeWidth={1.75} />
                        {t('resources.unused')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80 tabular-nums">
                    <span>{formatBytes(item.size)}</span>
                    <span className="truncate">{formatRelative(item.created_at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
