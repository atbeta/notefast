/**
 * 资源库 — 本地图片等媒体的浏览入口
 *
 * 图片始终本地存储（asset:<sha>）；图床外链是可选增强，在卡片上用状态标出。
 * 点击缩略图放大查看；未引用项可删除（DELETE /assets/:id，使用中拒绝）。
 * 不做相册/批量修图/DAM；设置页仍管图床命令配置。
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Cloud, CloudUpload, FileText, ImageIcon, Link2Off, Loader2, Trash2 } from 'lucide-react'
import { api, ApiError } from '../hooks/useAPI'
import { useImageUploadEnabled } from '../hooks/useImageUploadEnabled'
import { formatRelative } from '../lib/time'
import PageHeader from '../components/PageHeader'
import ConfirmDialog from '../components/ConfirmDialog'
import ImageLightbox from '../components/ImageLightbox'
import { ListRowsSkeleton, Tooltip, useToast, CopyButton } from '../components/ui'

const PAGE_SIZE = 60

interface AssetListItem {
  id: string
  mime: string
  size: number
  created_at: string
  /** 原始文件名（可空：存量/无法获取；回退显示哈希短前缀） */
  filename: string | null
  /** 本地文件路径（相对 data 目录，如 media/<id>；供复制/定位） */
  local_path: string
  remote: boolean
  remote_url: string | null
  referenced: boolean
  /** 引用该图片的文档数（>1 说明多篇复用同一张图） */
  ref_count: number
}

interface AssetRefDoc {
  doc_id: string
  title: string
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
  const imageUpload = useImageUploadEnabled()
  const [items, setItems] = useState<AssetListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offsetRef = useRef(0)

  const load = async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true)
    try {
      const res = await api.get<{ items: AssetListItem[]; total: number }>(
        `/assets?limit=${PAGE_SIZE}&offset=${offset}`,
      )
      offsetRef.current = offset + res.items.length
      setItems((prev) => (append ? [...prev, ...res.items] : res.items))
      setTotal(res.total)
      setError(null)
    } catch (e) {
      if (!append) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  const refetch = () => void load(0, false)
  const loadMore = () => {
    if (loadingMore || loading) return
    void load(offsetRef.current, true)
  }

  useEffect(() => { void load(0, false) }, [])

  const hasMore = items.length < total

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewRefs, setPreviewRefs] = useState<AssetRefDoc[] | null>(null)
  const [previewRefsError, setPreviewRefsError] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<AssetListItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 单图上传中 id 集合（仅本地图片可点上传） */
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set())
  /** 存量补传进度（从设置页 ImageUploadPanel 迁来） */
  const [batch, setBatch] = useState<UploadBatchStatus | null>(null)
  const [batchStarting, setBatchStarting] = useState(false)

  const preview = previewId ? items.find((i) => i.id === previewId) ?? null : null

  // lightbox 打开：拉引用来源列表
  useEffect(() => {
    if (!previewId) {
      setPreviewRefs(null)
      setPreviewRefsError(false)
      return
    }
    let cancelled = false
    setPreviewRefs(null)
    setPreviewRefsError(false)
    void api
      .get<{ docs: AssetRefDoc[] }>(`/assets/${previewId}/refs`)
      .then((r) => { if (!cancelled) setPreviewRefs(r.docs ?? []) })
      .catch(() => { if (!cancelled) setPreviewRefsError(true) })
    return () => { cancelled = true }
  }, [previewId])

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

  /** 一键清理未引用图片（宽限期 0：收件箱放弃等场景立即可清，不等 7 天） */
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  async function confirmCleanup() {
    if (cleaning) return
    setCleaning(true)
    try {
      const res = await api.post<{ deleted: number; ids: string[] }>('/assets/gc', { grace_ms: 0 })
      toast.success({ title: t('resources.cleanupDone', { n: res.deleted }) })
      setCleanupOpen(false)
      refetch()
    } catch (e) {
      toast.error({ title: e instanceof Error ? e.message : t('resources.cleanupFailed') })
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
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
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 存量补传：仅图床已启用时显示（否则点了必 400） */}
          {imageUpload.enabled && (
            <Tooltip label={t('resources.uploadExistingHint')}>
              <button
                type="button"
                onClick={() => void handleBatchUpload()}
                disabled={batchStarting || batch?.running}
                className="btn-ghost-custom shrink-0"
              >
                <CloudUpload className="w-3.5 h-3.5" strokeWidth={2} />
                {batchStarting ? t('common.loading') : t('resources.uploadExisting')}
              </button>
            </Tooltip>
          )}
          {/* 一键清理未引用（与回收站「清空」同 destructive 样式；宽限期 0 立即清） */}
          <Tooltip label={t('resources.cleanupHint')}>
            <button
              type="button"
              onClick={() => setCleanupOpen(true)}
              disabled={cleaning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 shrink-0"
            >
              {cleaning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              )}
              {t('resources.cleanupUnreferenced')}
            </button>
          </Tooltip>
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          {t('resources.description')}
        </p>

        {/* 存量补传进度（仅运行时出现，平时不占空间） */}
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

        {loading && items.length === 0 ? (
          <ListRowsSkeleton rows={6} />
        ) : error && items.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <ImageIcon className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">{t('common.error')}</h3>
            <p className="text-[13px] text-muted-foreground max-w-sm leading-relaxed break-all">
              {error}
            </p>
            <button
              type="button"
              onClick={refetch}
              className="inline-block mt-3 text-[13px] text-primary hover:underline"
            >
              {t('common.retry')}
            </button>
          </div>
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
                  <Tooltip label={t('common.delete')}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(item)
                      }}
                      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity inline-flex items-center justify-center w-7 h-7 rounded-md bg-background/90 border border-border/70 text-muted-foreground hover:text-destructive hover:border-destructive/40 shadow-sm"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                    </button>
                  </Tooltip>
                )}
                <div className="px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    {item.remote ? (
                      item.remote_url ? (
                        <Tooltip label={item.remote_url}>
                          <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                            <Cloud className="w-3 h-3" strokeWidth={1.75} />
                            {t('resources.remote')}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                          <Cloud className="w-3 h-3" strokeWidth={1.75} />
                          {t('resources.remote')}
                        </span>
                      )
                    ) : (
                      <span>{t('resources.local')}</span>
                    )}
                    <span className="text-muted-foreground/40">·</span>
                    {item.referenced ? (
                      <span className="inline-flex items-center gap-0.5">
                        <FileText className="w-3 h-3" strokeWidth={1.75} />
                        {item.ref_count > 1
                          ? t('resources.refCount', { n: item.ref_count })
                          : t('resources.inUse')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 text-muted-foreground/70">
                        <Link2Off className="w-3 h-3" strokeWidth={1.75} />
                        {t('resources.unused')}
                      </span>
                    )}
                    {!item.remote && imageUpload.enabled && (
                      <Tooltip label={t('resources.uploadLocal')}>
                        <button
                          type="button"
                          onClick={() => void handleUpload(item)}
                          disabled={uploadingIds.has(item.id)}
                          className="ml-auto inline-flex items-center gap-0.5 text-muted-foreground/70 hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {uploadingIds.has(item.id) ? (
                            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <CloudUpload className="w-3 h-3" strokeWidth={1.75} />
                          )}
                          {t('resources.uploadShort')}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80 tabular-nums">
                    <span>{formatBytes(item.size)}</span>
                    <span className="truncate">{formatRelative(item.created_at)}</span>
                  </div>
                  {/* 文件名 + 复制本地路径：让用户知道这图是哪个文件、在哪能找到 */}
                  <div className="flex items-center gap-1 min-w-0 pt-0.5">
                    <span className="truncate text-[10.5px] text-muted-foreground/80" title={item.filename || item.local_path}>
                      {item.filename || item.id.slice(0, 8)}
                    </span>
                    <CopyButton
                      text={item.local_path}
                      className="ml-auto shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-primary transition-colors disabled:opacity-50"
                      ariaLabel={t('resources.copyPath')}
                      title={t('resources.copyPath')}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {/* 分页：还有更多时显示加载更多（data 大时避免一次拉全） */}
        {hasMore && (
          <div className="flex justify-center pt-4">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-[12.5px] text-muted-foreground border border-border/70 hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
                  {t('common.loading')}
                </>
              ) : (
                t('resources.loadMore')
              )}
            </button>
          </div>
        )}
      </div>

      {preview && (
        <ImageLightbox
          src={`/api/v1/assets/${preview.id}`}
          alt={preview.filename || t('resources.preview')}
          onClose={() => setPreviewId(null)}
          headerStart={
            <div className="min-w-0 text-[12.5px] text-white/70 tabular-nums truncate">
              {formatBytes(preview.size)}
              <span className="mx-1.5 text-white/30">·</span>
              {preview.ref_count > 1
                ? t('resources.refCount', { n: preview.ref_count })
                : preview.referenced ? t('resources.inUse') : t('resources.unused')}
            </div>
          }
          headerActions={
            !preview.referenced ? (
              <button
                type="button"
                onClick={() => setPendingDelete(preview)}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12.5px] text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                {t('common.delete')}
              </button>
            ) : null
          }
          footer={
            <div className="max-h-40 overflow-y-auto">
              <div className="flex items-center gap-1.5 text-[11.5px] text-white/60 mb-1.5">
                <FileText className="w-3.5 h-3.5" strokeWidth={1.75} />
                {t('resources.refsIn')}
              </div>
              {previewRefsError ? (
                <p className="text-[12px] text-white/40">{t('resources.refsLoadError')}</p>
              ) : previewRefs === null ? (
                <p className="text-[12px] text-white/30">{t('common.loading')}</p>
              ) : previewRefs.length === 0 ? (
                <p className="text-[12px] text-white/40">{t('resources.refsNone')}</p>
              ) : (
                <ul className="space-y-0.5">
                  {previewRefs.map((d) => (
                    <li key={d.doc_id}>
                      <Link
                        to={`/doc/${d.doc_id}`}
                        onClick={() => setPreviewId(null)}
                        className="text-[12.5px] text-white/80 hover:text-white hover:underline underline-offset-2 transition-colors break-all line-clamp-1"
                      >
                        {d.title || t('common.untitled')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          }
        />
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

      <ConfirmDialog
        open={cleanupOpen}
        tone="destructive"
        title={t('resources.cleanupTitle')}
        message={t('resources.cleanupMessage')}
        confirmLabel={t('resources.cleanupConfirm')}
        busy={cleaning}
        busyLabel={t('resources.cleaning')}
        onConfirm={() => { void confirmCleanup() }}
        onCancel={() => {
          if (!cleaning) setCleanupOpen(false)
        }}
      />
    </div>
  )
}
