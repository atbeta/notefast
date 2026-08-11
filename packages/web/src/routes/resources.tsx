/**
 * 资源库 — 本地图片等媒体的浏览入口
 *
 * 图片始终本地存储（asset:<sha>）；图床外链是可选增强，在卡片上用状态标出。
 * 点击缩略图放大查看；未引用项可删除（DELETE /assets/:id，使用中拒绝）。
 * 不做相册/批量修图/DAM；设置页仍管图床命令配置。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Cloud, CloudUpload, ImageIcon, Link2Off, Loader2, Trash2, X } from 'lucide-react'
import { api, ApiError } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatRelative } from '../lib/time'
import PageHeader from '../components/PageHeader'
import ConfirmDialog from '../components/ConfirmDialog'
import { ListRowsSkeleton, useToast } from '../components/ui'

interface AssetListItem {
  id: string
  mime: string
  size: number
  created_at: string
  remote: boolean
  remote_url: string | null
  referenced: boolean
}

interface UploadBatchStatus {
  running: boolean
  total: number
  done: number
  ok: number
  failed: number
  lastError: string | null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function ResourcesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<{ items: AssetListItem[]; total: number }>('/assets?limit=200'),
    [],
  )
  const items = error ? [] : (data?.items ?? [])
  const total = data?.total ?? 0

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AssetListItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 单图上传中 id 集合（仅本地图片可点上传） */
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set())
  /** 存量补传进度（从设置页 ImageUploadPanel 迁来） */
  const [batch, setBatch] = useState<UploadBatchStatus | null>(null)
  const [batchStarting, setBatchStarting] = useState(false)

  const preview = previewId ? items.find((i) => i.id === previewId) ?? null : null

  /** 单图触发上传：成功刷新列表，失败 toast 显示原因（含未启用自动上传） */
  async function handleUpload(item: AssetListItem) {
    if (uploadingIds.has(item.id)) return
    setUploadingIds((prev) => new Set(prev).add(item.id))
    try {
      const res = await api.post<{ ok: boolean; url: string | null; error: string | null }>(`/assets/${item.id}/upload`, {})
      if (res.ok) {
        toast.success({ title: t('resources.uploaded') })
        refetch()
      } else {
        toast.error({ title: res.error || t('resources.uploadFailed') })
      }
    } catch (e) {
      toast.error({ title: e instanceof Error ? e.message : t('resources.uploadFailed') })
    } finally {
      setUploadingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  /** 存量图片补传：启动后台队列 + 轮询进度 */
  async function handleBatchUpload() {
    setBatchStarting(true)
    try {
      const res = await api.post<{ queued: number; running: boolean }>('/assets/upload-missing', {})
      if (res.queued === 0 && !res.running) {
        setBatch({ running: false, total: 0, done: 0, ok: 0, failed: 0, lastError: null })
      }
    } catch (e) {
      toast.error({ title: e instanceof Error ? e.message : t('resources.uploadFailed') })
    } finally {
      setBatchStarting(false)
    }
  }

  // 批量补传进行中：轮询进度（同 ImageUploadPanel）
  useEffect(() => {
    if (!batch?.running) return
    const timer = setInterval(() => {
      void api.get<UploadBatchStatus>('/assets/upload-status').then(setBatch).catch(() => {})
    }, 1200)
    return () => clearInterval(timer)
  }, [batch?.running])

  useEffect(() => {
    if (!previewId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendingDelete) {
        e.preventDefault()
        setPreviewId(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewId, pendingDelete])

  // 列表刷新后预览项已删 → 关掉 lightbox
  useEffect(() => {
    if (previewId && !items.some((i) => i.id === previewId)) setPreviewId(null)
  }, [items, previewId])

  async function confirmDelete() {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    try {
      await api.del(`/assets/${pendingDelete.id}`)
      toast.success({ title: t('resources.deleted') })
      if (previewId === pendingDelete.id) setPreviewId(null)
      setPendingDelete(null)
      refetch()
    } catch (e: unknown) {
      const msg =
        e instanceof ApiError && e.code === 'in_use'
          ? t('resources.deleteInUse')
          : e instanceof Error
            ? e.message
            : t('resources.deleteFailed')
      toast.error({ title: msg })
    } finally {
      setDeleting(false)
    }
  }

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

        {/* 存量补传：设置页迁来（图床命令配置仍在设置 → 图床与图片） */}
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex-1 min-w-0">
            {batch && (batch.running || batch.total > 0) && (
              <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-[11.5px] space-y-1">
                {batch.running ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                    <span>{t('resources.batchRunning', { done: batch.done, total: batch.total })}</span>
                  </div>
                ) : (
                  <p className="text-emerald-600 dark:text-emerald-400">
                    {t('resources.batchDone', { ok: batch.ok, failed: batch.failed })}
                  </p>
                )}
                {batch.failed > 0 && batch.lastError && (
                  <p className="text-destructive/90 break-all">{batch.lastError}</p>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleBatchUpload()}
            disabled={batchStarting || batch?.running}
            className="btn-ghost-custom shrink-0"
          >
            <CloudUpload className="w-3.5 h-3.5" strokeWidth={2} />
            {batchStarting ? t('common.loading') : t('resources.uploadExisting')}
          </button>
        </div>

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
                className="group relative rounded-lg border border-border/60 bg-card overflow-hidden shadow-[var(--shadow-card)]"
              >
                <button
                  type="button"
                  onClick={() => setPreviewId(item.id)}
                  className="aspect-square w-full bg-muted/40 flex items-center justify-center overflow-hidden cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  aria-label={t('resources.preview')}
                >
                  <img
                    src={`/api/v1/assets/${item.id}`}
                    alt=""
                    loading="lazy"
                    className="max-w-full max-h-full object-contain"
                  />
                </button>
                {!item.referenced && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(item)
                    }}
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity inline-flex items-center justify-center w-7 h-7 rounded-md bg-background/90 border border-border/70 text-muted-foreground hover:text-destructive hover:border-destructive/40 shadow-sm"
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                )}
                <div className="px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    {item.remote ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
                        title={item.remote_url ?? undefined}
                      >
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
                    {!item.remote && (
                      <button
                        type="button"
                        onClick={() => void handleUpload(item)}
                        disabled={uploadingIds.has(item.id)}
                        className="ml-auto inline-flex items-center gap-0.5 text-muted-foreground/70 hover:text-primary transition-colors disabled:opacity-50"
                        title={t('resources.uploadLocal')}
                      >
                        {uploadingIds.has(item.id) ? (
                          <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
                        ) : (
                          <CloudUpload className="w-3 h-3" strokeWidth={1.75} />
                        )}
                        {t('resources.uploadShort')}
                      </button>
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

      {preview &&
        createPortal(
          <div className="fixed inset-0 z-[90] flex flex-col">
            <div
              className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
              onClick={() => setPreviewId(null)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('resources.preview')}
              className="relative flex-1 flex flex-col min-h-0"
            >
              <div className="flex items-center justify-between gap-3 px-4 py-3 shrink-0">
                <div className="min-w-0 text-[12.5px] text-white/70 tabular-nums truncate">
                  {formatBytes(preview.size)}
                  <span className="mx-1.5 text-white/30">·</span>
                  {preview.referenced ? t('resources.inUse') : t('resources.unused')}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!preview.referenced && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(preview)}
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12.5px] text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                      {t('common.delete')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewId(null)}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                    aria-label={t('common.close')}
                  >
                    <X className="w-4 h-4" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
              <div
                className="flex-1 min-h-0 flex items-center justify-center px-4 pb-6 cursor-zoom-out"
                onClick={() => setPreviewId(null)}
              >
                <img
                  src={`/api/v1/assets/${preview.id}`}
                  alt=""
                  className="max-w-full max-h-full object-contain rounded-md shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        tone="destructive"
        title={t('resources.deleteTitle')}
        message={t('resources.deleteMessage')}
        confirmLabel={t('common.delete')}
        busy={deleting}
        busyLabel={t('resources.deleting')}
        onConfirm={() => { void confirmDelete() }}
        onCancel={() => {
          if (!deleting) setPendingDelete(null)
        }}
      />
    </div>
  )
}
