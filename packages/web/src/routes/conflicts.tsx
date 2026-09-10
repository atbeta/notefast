/**
 * 冲突副本（vault 模式）— RFC 0005 U-9
 *
 * 写回冲突（RFC 0003）与文件同步冲突（RFC 0004）都把 NoteFast 的版本另存为
 * `<原名>.notefast-conflict-<时间戳>.md`，且会被当普通笔记 ingest，所以这页直接来自索引。
 * 它们不是「待处理队列」而是「两份内容摆在这里」——对比后删掉不要的那份即可。
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileWarning, Loader2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import { EmptyState } from '../components/ui'

interface ConflictFile {
  rel_path: string
  name: string
  doc_id: string
  original_path: string | null
}

interface ConflictsResponse {
  count: number
  files: ConflictFile[]
}

export default function ConflictsPage() {
  const { t } = useTranslation()
  const { data, loading } = useApiQuery<ConflictsResponse>(
    () => api.get<ConflictsResponse>('/vault/conflicts'),
    [],
  )
  const files = data?.files ?? []

  return (
    <div className="animate-fade-in">
      <PageHeader>
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-md font-medium text-foreground truncate tracking-[-0.005em]">
            {t('conflicts.title')}
          </h1>
          {(data?.count ?? 0) > 0 && (
            <span className="font-mono text-xs text-muted-foreground/80 tabular-nums shrink-0">
              {data?.count}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-base text-muted-foreground leading-relaxed px-1">
          {t('conflicts.description')}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            icon={<FileWarning className="w-5 h-5" />}
            title={t('conflicts.emptyTitle')}
            description={t('conflicts.emptyDesc')}
          />
        ) : (
          <div className="grid gap-0.5">
            {files.map((file) => (
              <div key={file.rel_path} className="card-interactive px-3 py-2 flex items-center gap-3">
                <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <FileWarning className="w-3.5 h-3.5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/doc/${file.doc_id}`} className="block">
                    <h3 className="font-medium text-md text-foreground truncate leading-snug">
                      {file.name}
                    </h3>
                  </Link>
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                    {file.rel_path}
                  </p>
                  {file.original_path && (
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                      {t('conflicts.originalLabel')}: {file.original_path}
                    </p>
                  )}
                </div>
                <Link
                  to={`/doc/${file.doc_id}`}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent transition-colors"
                >
                  {t('conflicts.openDoc')}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
