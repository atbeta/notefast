import { useState, useRef, useEffect } from 'react'
import type { DocSummary } from '@notefast/core'
import { Link } from 'react-router-dom'
import { FileText, Pencil, Trash2, Check, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import ConfirmDialog from './ConfirmDialog'

interface DocListProps {
  docs: DocSummary[]
  onRefresh: () => void
}

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return diffMin + ' 分钟前'
  if (diffHr < 24) return diffHr + ' 小时前'
  if (diffDay < 7) return diffDay + ' 天前'
  return date.toLocaleDateString('zh-CN')
}

function DocCard({ doc, onRefresh }: { doc: DocSummary; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(doc.title)
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const saveTitle = async () => {
    if (!title.trim()) return
    try {
      await api.patch('/blocks/' + doc.id, { content: title.trim() })
      setEditing(false)
      onRefresh()
    } catch { /* keep editing */ }
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTitle() }
    if (e.key === 'Escape') { setTitle(doc.title); setEditing(false) }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await api.del('/docs/' + doc.id)
      setShowDelete(false)
      onRefresh()
    } catch { setDeleting(false); setShowDelete(false) }
  }

  return (
    <>
      <div className="card-interactive px-3.5 py-3 group flex items-center gap-3.5">
        {/* Icon tile：克制色，不抢标题层级 */}
        <div className="w-9 h-9 rounded-md bg-muted text-foreground/65 grid place-items-center shrink-0 group-hover:text-foreground transition-colors">
          <FileText className="w-4 h-4" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={() => { setTitle(doc.title); setEditing(false) }}
                className="flex-1 text-[14.5px] font-medium bg-transparent border-b border-primary text-foreground outline-none"
              />
              <button onMouseDown={(e) => { e.preventDefault(); saveTitle() }} className="p-0.5 text-primary hover:bg-primary/10 rounded transition-colors">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onMouseDown={(e) => { e.preventDefault(); setTitle(doc.title); setEditing(false) }} className="p-0.5 text-muted-foreground hover:bg-accent rounded transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <Link to={'/doc/' + doc.id} className="block">
              <h3 className="font-medium text-[14.5px] text-foreground tracking-[-0.005em] truncate group-hover:text-primary transition-colors">
                {doc.title || '未命名文档'}
              </h3>
            </Link>
          )}
          <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 font-mono tabular-nums">
            更新于 {formatRelative(doc.updated_at)}
          </p>
        </div>

        {/* Hover actions */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => { e.preventDefault(); setEditing(true); setTitle(doc.title) }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="重命名"
          >
            <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
          <button
            onClick={(e) => { e.preventDefault(); setShowDelete(true) }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showDelete}
        title="删除文档"
        message={`确定要删除「${doc.title || '未命名文档'}」吗？此操作不可撤销。`}
        confirmLabel={deleting ? '删除中...' : '删除'}
        destructive
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />
    </>
  )
}

export default function DocList({ docs, onRefresh }: DocListProps) {
  if (docs.length === 0) return null

  return (
    <div className="grid gap-1.5">
      {docs.map((doc) => (
        <DocCard key={doc.id} doc={doc} onRefresh={onRefresh} />
      ))}
    </div>
  )
}
