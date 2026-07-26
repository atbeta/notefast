/**
 * 归档（Archived）— 保留但不再活跃的内容
 *
 * 文档 status=archived；恢复为 note 后回到「所有文档」。
 * 归档文档默认不进 AI 检索（可显式包含），不污染回答。
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Archive, ArchiveRestore, Trash2, Loader2 } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { formatRelative } from '../lib/time'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'

export default function ArchivedPage() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocSummary | null>(null)

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<DocSummary[]>('/docs/list?status=archived'),
    [],
  )
  // 外部通道（MCP / AI 聊天）归档或恢复时即时刷新
  useDocChanges(() => refetch())
  // 原 .catch(() => setDocs([])) 语义：拉取失败按空列表渲染（空归档 UI）
  const docs = error ? [] : (data ?? [])

  const restore = async (id: string) => {
    setBusyId(id)
    try {
      await api.patch(`/docs/${id}/status`, { status: 'note' })
      refetch()
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    try {
      await api.del(`/docs/${deleteTarget.id}`)
      setDeleteTarget(null)
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
            归档
          </h1>
          {!loading && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          已过时但想保留的内容（如已解决的问题记录）。归档后不出现在所有文档，AI 回答默认也不再引用。
        </p>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card animate-pulse p-3.5 h-16" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Archive className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">没有归档文档</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
              在文档页点「归档」，把过时但想保留的内容收进来。
            </p>
          </div>
        ) : (
          <div className="grid gap-1.5">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="card-interactive px-3.5 py-3 group flex items-center gap-3.5"
              >
                <div className="w-9 h-9 rounded-lg bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <Archive className="w-4 h-4" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/doc/${doc.id}`} className="block">
                    <h3 className="font-medium text-[14.5px] text-foreground tracking-[-0.005em] truncate">
                      {doc.title || '未命名'}
                    </h3>
                  </Link>
                  <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 font-mono tabular-nums">
                    归档于 {formatRelative(doc.updated_at)}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => restore(doc.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors"
                    title="恢复为笔记（回到所有文档）"
                  >
                    {busyId === doc.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.75} />
                    )}
                    恢复为笔记
                  </button>
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => setDeleteTarget(doc)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除归档文档"
        message={`确定删除「${deleteTarget?.title || '未命名'}」吗？此操作不可撤销。`}
        confirmLabel="删除"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
