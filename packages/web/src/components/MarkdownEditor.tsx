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
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
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
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-secondary text-foreground text-sm font-medium rounded-xl hover:bg-accent disabled:opacity-50 transition-colors"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="w-full h-96 p-4 font-mono text-sm text-foreground bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring resize-y placeholder:text-muted-foreground transition-colors"
        placeholder="Enter Markdown content..."
      />
    </div>
  )
}
