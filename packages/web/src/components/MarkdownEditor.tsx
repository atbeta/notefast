import { useState, useEffect, useCallback, useRef } from 'react'
import { Edit3, Check, Loader2, Eye, EyeOff } from 'lucide-react'
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

  return <EditorInline docId={docId} onSaved={onSaved} onClose={() => setEditing(false)} />
}

function EditorInline({ docId, onSaved, onClose }: { docId: string; onSaved: () => void; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMd, setLoadingMd] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
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
    if (!loadingMd) {
      if (textareaRef.current) {
        textareaRef.current.focus()
        // 将光标移到末尾
        const len = textareaRef.current.value.length
        textareaRef.current.setSelectionRange(len, len)
      }
    }
  }, [loadingMd])

  // 自适应高度
  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [])

  useEffect(() => {
    handleInput()
  }, [content, handleInput])

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

  return (
    <div className="flex flex-col rounded-xl border border-primary/20 bg-card overflow-hidden shadow-sm animate-fade-in mt-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loadingMd}
            className="btn-primary-custom !py-1.5 !px-3"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" strokeWidth={2.25} />}
            {saving ? '保存中…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="btn-ghost-custom !py-1.5 !px-3"
          >
            Cancel
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Hint kbd="⌘S">保存</Hint>
          <Hint kbd="esc">取消</Hint>
          <span className="w-px h-3 bg-border mx-1" />
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className={
              'inline-flex items-center gap-1.5 px-2 py-1 rounded transition-colors ' +
              (showPreview
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-accent text-muted-foreground hover:text-foreground')
            }
            title="切换预览 ⌘P"
          >
            {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            Preview
          </button>
        </div>
      </div>

      {/* Editor + Preview */}
      <div className="flex flex-col md:flex-row min-h-[300px] bg-background divide-y md:divide-y-0 md:divide-x divide-border">
        <div className="flex-1 relative flex flex-col">
          {loadingMd ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" />
              加载 Markdown…
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onInput={handleInput}
              className="w-full min-h-[300px] p-5 font-mono text-[14px] text-foreground bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/50 leading-[1.65]"
              placeholder="输入 Markdown 内容…"
              spellCheck={false}
            />
          )}
        </div>
        {showPreview && (
          <div className="flex-1 bg-card/50 overflow-y-auto max-h-[70vh]">
            {loadingMd ? (
              <div className="p-5 text-muted-foreground text-sm">加载中…</div>
            ) : preview ? (
              <article className="prose dark:prose-invert max-w-none p-5 prose-sm">
                <BlockRenderer block={preview} />
              </article>
            ) : (
              <div className="p-5 text-sm text-muted-foreground italic">预览将在此显示</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Hint({ kbd, children }: { kbd: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="font-mono text-[10px] px-1 py-px border border-border rounded bg-background text-muted-foreground">{kbd}</kbd>
      <span>{children}</span>
    </span>
  )
}