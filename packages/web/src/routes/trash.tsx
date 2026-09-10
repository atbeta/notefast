/**
 * 回收站（Trash）— 软删除文档的恢复/永久删除入口
 *
 * 删除是软删除（tombstone）：内容仍在库中，恢复整子树回到「所有文档」。
 * 永久删除（DELETE /docs/:id/permanent）物理清库，不可恢复。
 * 两个不可恢复的副作用（既定语义，在描述里明示）：
 * - 分享旧链接永久失效（重开是新 token）
 * - 实体提及/链接由恢复路径自动重抽（reanalyzeDoc），非即时完成
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArchiveRestore, Loader2, Trash2, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { formatRelative } from '../lib/time'
import PageHeader from '../components/PageHeader'
import { useInstanceMode } from '../hooks/useInstanceMode'
import ConfirmDialog from '../components/ConfirmDialog'
import { EmptyState, ListRowsSkeleton, Tooltip, useToast } from '../components/ui'

interface TrashItem {
  id: string
  title: string
  deleted_at: string
}

/** `.trash/` 里的文件（vault 模式才有；见 GET /api/v1/vault/trash） */
interface VaultTrashFile {
  path: string
  name: string
  size: number
  mtime_ms: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function TrashPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  // 待确认的永久删除目标（null = 未打开对话框）
  const [confirmDelete, setConfirmDelete] = useState<TrashItem | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<TrashItem[]>('/docs/trash'),
    [],
  )
  // 外部通道（MCP / AI 聊天）删除或恢复时即时刷新
  useDocChanges(() => refetch())
  const docs = error ? [] : (data ?? [])

  // vault 模式：删除是把文件移进文件夹的 `.trash/`，那份清单来自文件系统而不是索引
  const { mode } = useInstanceMode()
  const vaultMode = mode === 'vault'
  const { data: vaultTrash } = useApiQuery(
    () => (vaultMode ? api.get<{ count: number; files: VaultTrashFile[]; truncated: boolean }>('/vault/trash') : Promise.resolve(null)),
    [vaultMode],
  )
  const trashedFiles = vaultMode ? (vaultTrash?.files ?? []) : []

  const restore = async (id: string) => {
    setBusyId(id)
    try {
      await api.post(`/blocks/${id}/restore`, {})
      refetch()
    } finally {
      setBusyId(null)
    }
  }

  /** 永久删除单个文档（不可恢复） */
  const permanentDelete = async (id: string) => {
    setBusyId(id)
    setConfirmDelete(null)
    try {
      await api.del(`/docs/${id}/permanent`)
      refetch()
      toast.success({ title: t('trash.delete') })
    } catch {
      toast.error({ title: t('trash.deleteFailed') })
    } finally {
      setBusyId(null)
    }
  }

  /** 清空回收站（不可恢复） */
  const emptyTrash = async () => {
    setBusyAll(true)
    setConfirmEmpty(false)
    try {
      await api.del('/docs/trash')
      refetch()
      toast.success({ title: t('trash.emptyTrash') })
    } catch {
      toast.error({ title: t('trash.emptyTrashFailed') })
    } finally {
      setBusyAll(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-md font-medium text-foreground truncate tracking-[-0.005em]">
            {t('trash.title')}
          </h1>
          {!loading && docs.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
        {!loading && docs.length > 0 && (
          <button
            type="button"
            disabled={busyAll}
            onClick={() => setConfirmEmpty(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 shrink-0"
          >
            {busyAll ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
            )}
            {t('trash.emptyTrash')}
          </button>
        )}
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-base text-muted-foreground leading-relaxed px-1">
          {vaultMode ? t('trash.descriptionVault') : t('trash.description')}
        </p>

        {vaultMode && trashedFiles.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-foreground">
                {t('trash.folderTitle')}
              </span>
              <span className="font-mono text-xs text-muted-foreground/80 tabular-nums">
                {trashedFiles.length}
              </span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('trash.folderHint')}
            </p>
            <div className="grid gap-0.5">
              {trashedFiles.slice(0, 20).map((file) => (
                <div key={file.path} className="flex items-center gap-2 text-xs">
                  <code className="min-w-0 flex-1 truncate text-muted-foreground">{file.path}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {formatSize(file.size)}
                  </span>
                </div>
              ))}
            </div>
            {trashedFiles.length > 20 && (
              <p className="text-xs text-muted-foreground/70">
                {t('trash.folderMore', { n: trashedFiles.length - 20 })}
              </p>
            )}
          </div>
        )}

        {loading ? (
          <ListRowsSkeleton rows={4} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<Trash2 className="w-5 h-5" />}
            title={t('trash.emptyTitle')}
            description={t('trash.emptyDesc')}
          />
        ) : (
          <div className="grid gap-0.5">
            {docs.map((doc) => (
              <div key={doc.id} className="card-interactive px-3 py-2 group flex items-center gap-3">
                <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-md text-foreground tracking-[-0.005em] truncate leading-snug">
                    {doc.title || t('common.unnamed')}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono tabular-nums">
                    {t('trash.deletedAt', { time: formatRelative(doc.deleted_at) })}
                  </p>
                </div>
                <Tooltip label={t('trash.restoreTitle')}>
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => restore(doc.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 shrink-0 disabled:opacity-40"
                  >
                    {busyId === doc.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.75} />
                    )}
                    {t('trash.restore')}
                  </button>
                </Tooltip>
                <Tooltip label={t('trash.delete')}>
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => setConfirmDelete(doc)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 shrink-0 disabled:opacity-40"
                  >
                    <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                    {t('trash.delete')}
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('trash.deleteTitle')}
        message={t('trash.deleteMessage')}
        confirmLabel={t('trash.delete')}
        tone="destructive"
        onConfirm={() => {
          if (confirmDelete) void permanentDelete(confirmDelete.id)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmDialog
        open={confirmEmpty}
        title={t('trash.emptyTrashTitle')}
        message={t('trash.emptyTrashMessage', { count: docs.length })}
        confirmLabel={t('trash.emptyTrash')}
        tone="destructive"
        onConfirm={() => {
          void emptyTrash()
        }}
        onCancel={() => setConfirmEmpty(false)}
      />
    </div>
  )
}
