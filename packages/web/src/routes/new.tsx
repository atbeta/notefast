import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { request } from '../hooks/useAPI'

interface Notebook {
  id: string
  name: string
}

export default function NewDocPage() {
  const navigate = useNavigate()
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    request<Notebook[]>('/notebooks')
      .then((list) => { if (list.length > 0) setNotebookId(list[0].id) })
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setError('请输入标题'); return }
    setCreating(true)
    setError('')

    try {
      let docId: string

      if (markdown.trim()) {
        const res = await request<{ doc: { id: string } }>('/import/markdown', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, markdown, title }),
        })
        docId = res.doc.id
      } else {
        const res = await request<{ id: string }>('/docs', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, title }),
        })
        docId = res.id
      }

      navigate('/doc/' + docId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
      setCreating(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <Link to="/" className="flex items-center gap-1.5 text-sm text-warm-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors mb-6">
        <ArrowLeft className="w-4 h-4" />返回
      </Link>

      <h1 className="text-2xl font-bold text-warm-900 dark:text-warm-50 mb-8">新建文档</h1>

      <form onSubmit={handleSubmit} className="space-y-6 max-w-lg">
        <div>
          <label className="block text-sm font-medium text-warm-700 dark:text-warm-200 mb-1.5">标题</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="输入文档标题"
            autoFocus
            className="w-full px-4 py-2.5 text-sm rounded-lg border border-warm-200 dark:border-warm-700 bg-white dark:bg-warm-800 text-warm-900 dark:text-warm-50 placeholder:text-warm-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-300 dark:focus:border-brand-600 transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-warm-700 dark:text-warm-200 mb-1.5">Markdown 内容（可选）</label>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder="支持 Markdown 格式&#10;&#10;# 一级标题&#10;正文内容&#10;&#10;## 二级标题&#10;更多内容"
            rows={12}
            className="w-full px-4 py-2.5 text-sm rounded-lg border border-warm-200 dark:border-warm-700 bg-white dark:bg-warm-800 text-warm-900 dark:text-warm-50 placeholder:text-warm-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-300 dark:focus:border-brand-600 transition-all font-mono resize-y"
          />
        </div>

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        <button
          type="submit"
          disabled={creating}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          {creating ? '创建中...' : '创建文档'}
        </button>
      </form>
    </div>
  )
}
