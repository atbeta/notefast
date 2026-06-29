import { useState } from 'react'
import { request } from '../hooks/useAPI'
import { Edit3, Check, X, Loader2 } from 'lucide-react'

interface MarkdownEditorProps {
  docId: string
  onSaved: () => void
}

export default function MarkdownEditor({ docId, onSaved }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMd, setLoadingMd] = useState(false)

  const handleStartEdit = async () => {
    setEditing(true)
    setLoadingMd(true)
    try {
      const { markdown } = await request<{ markdown: string }>(`/docs/${docId}/export/markdown`)
      setContent(markdown)
    } catch {
      setContent('')
    } finally {
      setLoadingMd(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await request<unknown>(`/docs/${docId}/markdown`, {
        method: 'PUT',
        body: JSON.stringify({ markdown: content }),
      })
      setEditing(false)
      onSaved()
    } catch (e) {
      console.error('Save failed', e)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        onClick={handleStartEdit}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-warm-700 dark:text-warm-200 bg-warm-100 dark:bg-warm-800 hover:bg-warm-200 dark:hover:bg-warm-700 hover:text-brand-600 dark:hover:text-brand-400 rounded-xl transition-colors"
      >
        <Edit3 className="w-4 h-4" />
        Edit
      </button>
    )
  }

  if (loadingMd) {
    return (
      <div className="inline-flex items-center gap-2 px-4 py-2 text-sm text-warm-600 dark:text-warm-400 bg-warm-50 dark:bg-warm-900 border border-warm-200 dark:border-warm-700 rounded-xl">
        <Loader2 className="w-4 h-4 animate-spin text-brand-500" />
        <span>Loading Markdown...</span>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-brand-500 text-white text-sm font-medium rounded-xl hover:bg-brand-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleCancel}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-warm-100 dark:bg-warm-800 text-warm-700 dark:text-warm-200 text-sm font-medium rounded-xl hover:bg-warm-200 dark:hover:bg-warm-700 disabled:opacity-50 transition-colors"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="w-full h-96 p-4 font-mono text-sm text-warm-900 dark:text-warm-50 bg-warm-50 dark:bg-warm-900 border border-warm-200 dark:border-warm-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-brand-400 dark:focus:border-brand-600 resize-y placeholder:text-warm-400 dark:placeholder:text-warm-500 transition-colors"
        placeholder="Enter Markdown content..."
      />
    </div>
  )
}
