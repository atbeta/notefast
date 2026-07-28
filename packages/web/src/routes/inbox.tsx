/**
 * 收集箱（Inbox）— 待整理素材
 *
 * 文档 status=inbox；整理升格为 note 后进入「所有文档」。
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Inbox, Plus, ArrowUpRight, Loader2 } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatRelative } from '../lib/time'
import DocActionsMenu from '../components/DocActionsMenu'
import PageHeader from '../components/PageHeader'

export default function InboxPage() {
  const navigate = useNavigate()
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [showCapture, setShowCapture] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<DocSummary[]>('/docs/list?status=inbox'),
    [],
  )
  // 原 .catch(() => setDocs([])) 语义：拉取失败按空列表渲染（空收集箱 UI）
  const docs = error ? [] : (data ?? [])

  const { data: notebooks } = useApiQuery(() => api.get<Array<{ id: string }>>('/notebooks'), [])
  useEffect(() => {
    if (notebooks?.[0]) setNotebookId(notebooks[0].id)
  }, [notebooks])

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
      </PageHeader>

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
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => promote(doc.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    title="加入笔记（离开收集箱）"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                    加入笔记
                  </button>
                  <DocActionsMenu
                    doc={{ ...doc, status: 'inbox' }}
                    surface="inbox"
                    onDone={refetch}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
