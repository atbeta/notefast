import { useState } from 'react'
import { request } from '../hooks/useAPI'
import { Edit3, Check, X } from 'lucide-react'

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
      console.error('保存失败', e)
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
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-blue-600 transition-colors"
      >
        <Edit3 className="w-4 h-4" />
        编辑
      </button>
    )
  }

  if (loadingMd) {
    return <div className="text-sm text-gray-400">加载中...</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" />
          {saving ? '保存中...' : '保存'}
        </button>
        <button
          onClick={handleCancel}
          className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 transition-colors"
        >
          <X className="w-4 h-4" />
          取消
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="w-full h-96 p-4 font-mono text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
        placeholder="输入 Markdown 内容..."
      />
    </div>
  )
}
