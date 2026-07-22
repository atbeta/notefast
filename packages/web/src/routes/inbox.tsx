/**
 * 收集箱（Inbox）— 待整理素材
 *
 * 文档 status=inbox；整理升格为 note 后进入「所有文档」。
 */

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Inbox, Plus, ArrowUpRight, Trash2, Loader2 } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import ConfirmDialog from '../components/ConfirmDialog'

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHr < 24) return `${diffHr} 小时前`
  if (diffDay < 7) return `${diffDay} 天前`
  return date.toLocaleDateString('zh-CN')
}

export default function InboxPage() {
  const navigate = useNavigate()
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [showCapture, setShowCapture] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocSummary | null>(null)

  const fetchDocs = useCallback(() => {
    setLoading(true)
    api
      .get<DocSummary[]>('/docs/list?status=inbox')
      .then(setDocs)
      .catch(() => setDocs([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  useEffect(() => {
    api
      .get<Array<{ id: string }>>('/notebooks')
      .then((list) => { if (list[0]) setNotebookId(list[0].id) })
      .catch(() => {})
  }, [])

  const handleCapture = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!notebookId || capturing) return
    const finalTitle = title.trim() || new Date().toLocaleString('zh-CN', {
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
      fetchDocs()
      navigate(`/doc/${res.id}`)
    } catch {
      setCapturing(false)
    }
  }

  const promote = async (id: string) => {
    setBusyId(id)
    try {
      await api.patch(`/docs/${id}/status`, { status: 'note' })
      fetchDocs()
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
      fetchDocs()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="animate-fade-in">
      <header className="sticky top-0 z-10 h-14 border-b border-border/50 bg-background">
        <div className="h-full w-full max-w-4xl mx-auto px-8 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-2">
            <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
              收集箱
            </h1>
            {!loading && (
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
            快速采集
          </button>
        </div>
      </header>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          随手记下的素材、剪藏与草稿。整理后「加入笔记」才会出现在所有文档里。
        </p>

        {showCapture && (
          <form onSubmit={handleCapture} className="card p-4 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标题（可空，自动用时间）"
              className="w-full text-[14px] bg-transparent border-b border-border outline-none py-1.5 text-foreground placeholder:text-muted-foreground/50"
              autoFocus
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="粘贴内容或链接备注（Markdown）…"
              rows={5}
              className="w-full text-[13px] bg-muted/30 rounded-md border border-border/60 px-3 py-2 outline-none resize-y text-foreground placeholder:text-muted-foreground/50"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCapture(false)}
                className="text-[13px] px-3 py-1.5 text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={capturing || !notebookId}
                className="btn-primary-custom"
              >
                {capturing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                存入收集箱
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card animate-pulse p-3.5 h-16" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Inbox className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">收集箱是空的</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
              先快速采集一段文字或链接；整理完成后再加入正式笔记。
            </p>
            <button type="button" onClick={() => setShowCapture(true)} className="btn-primary-custom">
              <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
              快速采集
            </button>
          </div>
        ) : (
          <div className="grid gap-1.5">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="card-interactive px-3.5 py-3 group flex items-center gap-3.5"
              >
                <div className="w-9 h-9 rounded-lg bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
                  <Inbox className="w-4 h-4" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/doc/${doc.id}`} className="block">
                    <h3 className="font-medium text-[14.5px] text-foreground tracking-[-0.005em] truncate">
                      {doc.title || '未命名'}
                    </h3>
                  </Link>
                  <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 font-mono tabular-nums">
                    采集于 {formatRelative(doc.created_at)}
                    {doc.updated_at !== doc.created_at && ` · 更新 ${formatRelative(doc.updated_at)}`}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => promote(doc.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors"
                    title="加入笔记（离开收集箱）"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                    加入笔记
                  </button>
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => setDeleteTarget(doc)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="丢弃"
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
        title="丢弃收集项"
        message={`确定丢弃「${deleteTarget?.title || '未命名'}」吗？此操作不可撤销。`}
        confirmLabel="丢弃"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
