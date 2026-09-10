/**
 * 未解析链接（vault 模式）— RFC 0005 U-9
 *
 * `[[目标]]` 指向还不存在的笔记时，索引里记的是「谁引用了什么名字」（vault_unresolved_links）。
 * 目标文件建好后引用会自动接上（软解析的「后到先解」），所以这页是**提示**而非待办清单：
 * 用来发现错别字、忘记创建的笔记、以及被改名后失联的引用。
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Link2Off, Loader2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import { EmptyState } from '../components/ui'

interface UnresolvedSource {
  doc_id: string
  rel_path: string | null
}

interface UnresolvedTarget {
  target_name: string
  anchor: string
  count: number
  sources: UnresolvedSource[]
}

interface UnresolvedResponse {
  total: number
  targets: UnresolvedTarget[]
}

export default function UnresolvedPage() {
  const { t } = useTranslation()
  const { data, loading } = useApiQuery<UnresolvedResponse>(
    () => api.get<UnresolvedResponse>('/vault/links/unresolved'),
    [],
  )
  const targets = data?.targets ?? []

  return (
    <div className="animate-fade-in">
      <PageHeader>
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-md font-medium text-foreground truncate tracking-[-0.005em]">
            {t('unresolved.title')}
          </h1>
          {(data?.total ?? 0) > 0 && (
            <span className="font-mono text-xs text-muted-foreground/80 tabular-nums shrink-0">
              {data?.total}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-base text-muted-foreground leading-relaxed px-1">
          {t('unresolved.description')}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
          </div>
        ) : targets.length === 0 ? (
          <EmptyState
            icon={<Link2Off className="w-5 h-5" />}
            title={t('unresolved.emptyTitle')}
            description={t('unresolved.emptyDesc')}
          />
        ) : (
          <div className="grid gap-1">
            {targets.map((target) => (
              <div
                key={`${target.target_name}\u0000${target.anchor}`}
                className="card-interactive px-3 py-2.5 space-y-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <code className="min-w-0 flex-1 text-base text-foreground truncate">
                    [[{target.target_name}
                    {target.anchor ? `#${target.anchor}` : ''}]]
                  </code>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t('unresolved.targetCount', { n: target.count })}
                  </span>
                </div>
                {target.sources.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="shrink-0">{t('unresolved.sourceLabel')}</span>
                    {target.sources.map((source) => (
                      <Link
                        key={source.doc_id}
                        to={`/doc/${source.doc_id}`}
                        title={source.rel_path ?? undefined}
                        className="max-w-[16rem] truncate rounded-md border border-border/60 px-1.5 py-px hover:bg-accent transition-colors"
                      >
                        {source.rel_path ?? source.doc_id.slice(0, 8)}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
