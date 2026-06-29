import { useState, useEffect, useCallback, useRef } from 'react'
import { Edit3, Check, X, Loader2, Eye, EyeOff } from 'lucide-react'
import { parseMarkdownToBlocks, inputsToBlockTree } from '@notefast/core'
import type { Block } from '@notefast/core'
import { api } from '../hooks/useAPI'
import BlockRenderer from './BlockRenderer'

interface MarkdownEditorProps {
  docId: string
  onSaved: () => void
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

export default function MarkdownEditor({ docId, onSaved }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMd, setLoadingMd] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draftTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const preview: Block | null = showPreview && content
    ? (() => { try { const inputs = parseMarkdownToBlocks(content, '__preview__'); const tree = inputsToBlockTree(inputs); return tree.length > 0 ? tree[0] : null } catch { return null } })()
    : null

  const handleStartEdit = useCallback(async () => {
    setEditing(true)
    setLoadingMd(true)
    try {
      const draft = loadDraft(docId)
      if (draft) {
        setContent(draft)
      } else {
        const { markdown } = await api.get<{ markdown: string }>(`/docs/${docId}/export/markdown`)
        setContent(markdown)
      }
    } catch { setContent('') }
    finally { setLoadingMd(false) }
  }, [docId])

  useEffect(() => {
    if (editing) {
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [editing])

  // Auto-save draft every 30s
  useEffect(() => {
    if (!editing) return
    draftTimerRef.current = setInterval(() => {
      if (content) saveDraft(docId, content)
    }, 30000)
    return () => clearInterval(draftTimerRef.current)
  }, [editing, docId, content])

  // Keyboard shortcuts
  useEffect(() => {
    if (!editing) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setShowPreview((p) => !p)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editing, content])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put(`/docs/${docId}/markdown`, { markdown: content })
      clearDraft(docId)
      setEditing(false)
      onSaved()
    } catch {
      saveDraft(docId, content)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = useCallback(() => {
    saveDraft(docId, content)
    setEditing(false)
  }, [docId, content])

  if (!editing) {
    return (
      <button
        onClick={handleStartEdit}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-secondary hover:bg-accent hover:text-primary rounded-xl transition-colors"
      >
        <Edit3 className="w-4 h-4" />
        Edit
      </button>
    )
  }

  if (loadingMd) {
    return (
      <div className="inline-flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground bg-background border border-border rounded-xl">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span>Loading Markdown...</span>
      </div>
    )
  }

  return (
    <div className="space-y-3 w-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
            <kbd className="hidden sm:inline text-[10px] opacity-60 ml-1 font-mono">⌘S</kbd>
          </button>
          <button
            onClick={handleCancel}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-secondary text-foreground text-sm font-medium rounded-xl hover:bg-accent disabled:opacity-50 transition-colors"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
        </div>
        <button
          onClick={() => setShowPreview((p) => !p)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl transition-colors ${
            showPreview
              ? 'bg-primary/10 text-primary'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
          title="切换预览 ⌘P"
        >
          {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          Preview ⌘P
        </button>
      </div>

      {/* Editor + Preview */}
      <div className={`flex ${showPreview ? 'gap-4' : ''}`}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className={`${showPreview ? 'w-1/2' : 'w-full'} h-[70vh] p-4 font-mono text-sm text-foreground bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring resize-none placeholder:text-muted-foreground transition-colors`}
          placeholder="Enter Markdown content..."
          spellCheck={false}
        />
        {showPreview && (
          <div className="w-1/2 h-[70vh] overflow-y-auto p-6 border border-border rounded-xl bg-card">
            {preview ? (
              <article className="prose dark:prose-invert max-w-none">
                <BlockRenderer block={preview} />
              </article>
            ) : (
              <p className="text-muted-foreground text-sm italic">预览将在此显示</p>
            )}
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        <kbd className="px-1 py-0.5 rounded bg-secondary font-mono">⌘S</kbd> 保存
        <span className="mx-2">·</span>
        <kbd className="px-1 py-0.5 rounded bg-secondary font-mono">⌘P</kbd> 切换预览
        <span className="mx-2">·</span>
        <kbd className="px-1 py-0.5 rounded bg-secondary font-mono">Esc</kbd> 取消
        <span className="mx-2">·</span>
        草稿每 30 秒自动保存
      </p>
    </div>
  )
}
