import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Edit3, Check, X, Loader2, Eye, EyeOff, Command } from 'lucide-react'
import { parseMarkdownToBlocks, inputsToBlockTree } from '@notefast/core'
import type { Block } from '@notefast/core'
import { api } from '../hooks/useAPI'
import BlockRenderer from './BlockRenderer'

interface MarkdownEditorProps {
  docId: string
  onSaved: () => void
  autoEdit?: boolean
}

const DRAFT_PREFIX = 'notefast-draft-'

function loadDraft(docId: string): string | null {
  try { return localStorage.getItem(DRAFT_PREFIX + docId) } catch { return null }
}

function saveDraft(docId: string, content: string) {
  try { localStorage.setItem(DRAFT_PREFIX + docId, content) } catch { /* ignore */ }
}

function clearDraft(docId: string) {
  try { localStorage.removeItem(DRAFT_PREFIX + docId) } catch { /* ignore */ }
}

export default function MarkdownEditor({ docId, onSaved, autoEdit = false }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(autoEdit)

  const handleStartEdit = useCallback(() => setEditing(true), [])

  if (!editing) {
    return (
      <button
        onClick={handleStartEdit}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-secondary hover:bg-accent hover:text-primary rounded-btn transition-colors"
      >
        <Edit3 className="w-4 h-4" />
        Edit
      </button>
    )
  }

  return <EditorModal docId={docId} onSaved={onSaved} onClose={() => setEditing(false)} />
}

function EditorModal({ docId, onSaved, onClose }: { docId: string; onSaved: () => void; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMd, setLoadingMd] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 加载 Markdown
  useEffect(() => {
    let cancelled = false
    setLoadingMd(true)
    const draft = loadDraft(docId)
    if (draft) {
      setContent(draft)
      setLoadingMd(false)
      return
    }
    api.get<{ markdown: string }>(`/docs/${docId}/export/markdown`)
      .then((r) => { if (!cancelled) setContent(r.markdown) })
      .catch(() => { if (!cancelled) setContent('') })
      .finally(() => { if (!cancelled) setLoadingMd(false) })
    return () => { cancelled = true }
  }, [docId])

  useEffect(() => {
    if (!loadingMd) setTimeout(() => textareaRef.current?.focus(), 30)
  }, [loadingMd])

  // 解析预览
  const preview: Block | null = showPreview && content
    ? (() => { try { const inputs = parseMarkdownToBlocks(content, '__preview__'); const tree = inputsToBlockTree(inputs); return tree.length > 0 ? tree[0] : null } catch { return null } })()
    : null

  // 自动保存草稿（30s）
  useEffect(() => {
    const id = setInterval(() => { if (content) saveDraft(docId, content) }, 30000)
    return () => clearInterval(id)
  }, [docId, content])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await api.put(`/docs/${docId}/markdown`, { markdown: content })
      clearDraft(docId)
      onSaved()
      onClose()
    } catch {
      saveDraft(docId, content)
    } finally {
      setSaving(false)
    }
  }, [saving, content, docId, onSaved, onClose])

  const handleCancel = useCallback(() => {
    saveDraft(docId, content)
    onClose()
  }, [docId, content, onClose])

  // 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setShowPreview((p) => !p)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave, handleCancel])

  // 锁住 body 滚动
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const modal = (
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-background animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Markdown 编辑器"
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loadingMd}
            className="btn-primary-custom"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" strokeWidth={2.25} />}
            {saving ? '保存中…' : 'Save'}
            <Kbd>S</Kbd>
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="btn-ghost-custom"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-btn transition-colors ' +
              (showPreview
                ? 'bg-primary-soft text-primary'
                : 'bg-secondary text-muted-foreground hover:text-foreground')
            }
            title="切换预览 ⌘P"
          >
            {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            Preview
            <Kbd>P</Kbd>
          </button>
        </div>
      </div>

      {/* Editor + Preview */}
      <div className="flex-1 min-h-0 grid gap-px bg-border" style={{ gridTemplateColumns: showPreview ? '1fr 1fr' : '1fr' }}>
        <div className="relative bg-background">
          {loadingMd ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2 text-primary" />
              加载 Markdown…
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full p-6 font-mono text-sm text-foreground bg-background resize-none focus:outline-none placeholder:text-muted-foreground/70 leading-relaxed"
              placeholder="输入 Markdown 内容…"
              spellCheck={false}
            />
          )}
        </div>
        {showPreview && (
          <div className="bg-card overflow-y-auto">
            {loadingMd ? (
              <div className="p-6 text-muted-foreground text-sm">加载中…</div>
            ) : preview ? (
              <article className="prose dark:prose-invert max-w-none p-7">
                <BlockRenderer block={preview} />
              </article>
            ) : (
              <div className="p-6 text-sm text-muted-foreground italic">预览将在此显示</div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between gap-3 px-6 h-9 border-t border-border bg-card text-[11px] text-muted-foreground shrink-0">
        <div className="flex items-center gap-3">
          <span>Markdown 模式</span>
          <span>·</span>
          <span>{content.length} 字</span>
        </div>
        <div className="flex items-center gap-3">
          <Hint kbd="S" icon={<Command className="w-3 h-3" />}>保存</Hint>
          <Hint kbd="P" icon={<Command className="w-3 h-3" />}>切换预览</Hint>
          <Hint kbd="esc">取消</Hint>
          <span>·</span>
          <span>草稿每 30 秒自动保存到本地</span>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="hidden sm:inline-flex items-center font-mono text-[10px] px-1 py-px ml-1 border border-white/20 rounded bg-white/10 text-current opacity-80">
      {children}
    </kbd>
  )
}

function Hint({ kbd, icon, children }: { kbd: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <kbd className="font-mono text-[10px] px-1 py-px border border-border rounded bg-secondary text-muted-foreground">{kbd}</kbd>
      <span>{children}</span>
    </span>
  )
}