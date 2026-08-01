import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import type { DocSummary } from '@notefast/core'
import { Link } from 'react-router-dom'
import { FileText, Check, X, EyeOff } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { formatRelative } from '../lib/time'
import DocActionsMenu from './DocActionsMenu'

interface DocListProps {
  docs: DocSummary[]
  onRefresh: () => void
}

function DocCard({ doc, onRefresh }: { doc: DocSummary; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(doc.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const tags = doc.tags ?? []
  const aiExclude = doc.ai_exclude === true

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    setTitle(doc.title)
  }, [doc.title])

  const saveTitle = async () => {
    if (!title.trim()) return
    try {
      await api.patch('/blocks/' + doc.id, { content: title.trim() })
      setEditing(false)
      onRefresh()
    } catch { /* keep editing */ }
  }

  const handleTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTitle() }
    if (e.key === 'Escape') { setTitle(doc.title); setEditing(false) }
  }

  return (
    <div className="card-interactive px-3 py-2 group flex items-center gap-3">
      <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0 group-hover:bg-muted group-hover:text-foreground/80 transition-colors">
        {aiExclude
          ? <EyeOff className="w-3.5 h-3.5" strokeWidth={1.5} />
          : <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />}
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
              className="flex-1 text-[14px] font-medium bg-transparent border-b border-primary text-foreground outline-none"
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
            <h3 className="font-medium text-[14px] text-foreground tracking-[-0.005em] truncate flex items-center gap-1.5 leading-snug">
              <span className="truncate">{doc.title || '未命名文档'}</span>
              {aiExclude && (
                <span className="shrink-0 text-[10px] font-medium px-1.5 py-px rounded border border-border/70 text-muted-foreground">
                  AI 隐藏
                </span>
              )}
            </h3>
          </Link>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {tags.slice(0, 4).map((t) => (
              <Link
                key={t}
                to={`/?tags=${encodeURIComponent(t)}`}
                className="text-[10.5px] font-mono px-1.5 py-px rounded-full bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {t}
              </Link>
            ))}
            {tags.length > 4 && (
              <span className="text-[10.5px] text-muted-foreground/70 font-mono">+{tags.length - 4}</span>
            )}
          </div>
        )}
      </div>

      {!editing && (
        <div className="flex items-center gap-1 shrink-0">
          <time
            className="text-[11.5px] text-muted-foreground font-mono tabular-nums whitespace-nowrap text-right min-w-[4.5rem]"
            dateTime={doc.updated_at}
            title={`更新于 ${doc.updated_at}`}
          >
            {formatRelative(doc.updated_at)}
          </time>
          <DocActionsMenu
            doc={doc}
            surface="list"
            onDone={onRefresh}
            onRename={() => { setEditing(true); setTitle(doc.title) }}
          />
        </div>
      )}
    </div>
  )
}

export default function DocList({ docs, onRefresh }: DocListProps) {
  if (docs.length === 0) return null

  return (
    <div className="grid gap-0.5">
      {docs.map((doc) => (
        <DocCard key={doc.id} doc={doc} onRefresh={onRefresh} />
      ))}
    </div>
  )
}
