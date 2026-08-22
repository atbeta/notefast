/**
 * 收集箱（Inbox）— 待整理素材
 *
 * 文档 status=inbox；整理升格为 note 后进入「所有文档」。
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Inbox, Plus, ArrowUpRight, Loader2 } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { usePagedDocList } from '../hooks/usePagedDocList'
import { useDocChanges } from '../hooks/useDocEvents'
import { formatRelative, currentLocale } from '../lib/time'
import DocActionsMenu from '../components/DocActionsMenu'
import PageHeader from '../components/PageHeader'
import { EmptyState, ListRowsSkeleton, Tooltip } from '../components/ui'

export default function InboxPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [showCapture, setShowCapture] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const { docs, loading, error, refetch, hasMore, loadingMore, loadMore } = usePagedDocList('/docs/list?status=inbox')

  // 外部 MCP / AI 聊天等任何通道写入 → 即时刷新列表（对齐 archived 页）
  useDocChanges(() => refetch())

  const { data: notebooks } = useApiQuery(() => api.get<Array<{ id: string }>>('/notebooks'), [])
  useEffect(() => {
    if (notebooks?.[0]) setNotebookId(notebooks[0].id)
  }, [notebooks])

  const handleCapture = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!notebookId || capturing) return
    const finalTitle = title.trim() || new Date().toLocaleString(currentLocale(), {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    setCapturing(true)
    try {
      const res = await api.post<DocSummary>('/docs', {
        notebook_id: notebookId,
        title: finalTitle,
        status: 'inbox',
        ...(body.trim() ? { markdown: body.trim() } : {}),
      })
      setTitle('')
      setBody('')
      setShowCapture(false)
      refetch()
      navigate(`/doc/${res.id}`)
    } catch {
      setCapturing(false)
    }
  }

  const promote = async (id: string) => {
    setBusyId(id)
    try {
      await api.patch(`/docs/${id}/status`, { status: 'note' })
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
            {t('inbox.title')}
          </h1>
          {!loading && docs.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowCapture((v) => !v)}
          className="btn-primary-custom shrink-0"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
          {t('inbox.capture')}
        </button>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          {t('inbox.description')}
        </p>

        {showCapture && (
          <form onSubmit={handleCapture} className="card p-4 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('inbox.titlePlaceholder')}
              className="w-full text-[14px] bg-transparent border-b border-border outline-none py-1.5 text-foreground placeholder:text-muted-foreground/50"
              autoFocus
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('inbox.bodyPlaceholder')}
              rows={5}
              className="w-full text-[13px] bg-muted/30 rounded-md border border-border/60 px-3 py-2 outline-none resize-y text-foreground placeholder:text-muted-foreground/50"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCapture(false)}
                className="text-[13px] px-3 py-1.5 text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={capturing || !notebookId}
                className="btn-primary-custom"
              >
                {capturing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t('inbox.save')}
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <ListRowsSkeleton rows={4} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            title={t('inbox.emptyTitle')}
            description={t('inbox.emptyDesc')}
          />
        ) : (
          <div className="grid gap-0.5">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="card-interactive px-3 py-2 group flex items-center gap-3"
              >
                <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <Inbox className="w-3.5 h-3.5" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/doc/${doc.id}`} className="block">
                    <h3 className="font-medium text-[14px] text-foreground tracking-[-0.005em] truncate leading-snug">
                      {doc.title || t('common.unnamed')}
                    </h3>
                  </Link>
                  <p className="text-[11.5px] text-muted-foreground mt-0.5 font-mono tabular-nums">
                    {t('inbox.capturedAt', { time: formatRelative(doc.created_at) })}
                    {doc.updated_at !== doc.created_at && t('inbox.updatedSuffix', { time: formatRelative(doc.updated_at) })}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Tooltip label={t('inbox.addToNotesTitle')}>
                    <button
                      type="button"
                      disabled={busyId === doc.id}
                      onClick={() => promote(doc.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                      {t('inbox.addToNotes')}
                    </button>
                  </Tooltip>
                  <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                    <DocActionsMenu
                      doc={{ ...doc, status: 'inbox' }}
                      surface="inbox"
                      onDone={refetch}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {hasMore && !error && docs.length > 0 && (
          <div className="pt-2 flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
            >
              {loadingMore ? t('home.loadingMore') : t('home.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
