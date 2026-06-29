import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import type { Block } from '@notefast/core'
import { ArrowLeft, Trash2, Pencil, Check, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import DocTree from '../components/DocTree'
import Backlinks from '../components/Backlinks'
import MarkdownEditor from '../components/MarkdownEditor'
import ConfirmDialog from '../components/ConfirmDialog'

export default function DocPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // 删除确认对话框
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 内联标题编辑
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    api.get<Block>('/docs/' + id).then(setDoc).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [id, refreshKey])

  const handleEditSaved = useCallback(() => { setRefreshKey((k) => k + 1) }, [])

  const startTitleEdit = () => {
    if (!doc) return
    setTitleDraft(doc.content)
    setEditingTitle(true)
  }

  const saveTitle = async () => {
    if (!id || !doc || !titleDraft.trim()) return
    try {
      await api.patch('/blocks/' + id, { content: titleDraft.trim() })
      setEditingTitle(false)
      setRefreshKey((k) => k + 1)
    } catch {
      // keep editing on error
    }
  }

  const cancelTitleEdit = () => {
    setEditingTitle(false)
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTitle() }
    if (e.key === 'Escape') cancelTitleEdit()
  }

  const handleDelete = async () => {
    if (!id) return
    setDeleting(true)
    try {
      await api.del('/docs/' + id)
      navigate('/')
    } catch {
      setDeleting(false)
      setShowDelete(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-secondary rounded-lg w-2/3" />
        <div className="h-4 bg-secondary rounded w-full" />
        <div className="h-4 bg-secondary rounded w-5/6" />
        <div className="h-4 bg-secondary rounded w-4/6" />
      </div>
    )
  }
  if (error) return <div className="text-center py-24"><p className="text-destructive mb-4">{error}</p><Link to="/" className="text-primary hover:underline text-sm">返回首页</Link></div>
  if (!doc) return <div className="text-center py-24"><p className="text-muted-foreground mb-4">文档不存在</p><Link to="/" className="text-primary hover:underline text-sm">返回首页</Link></div>

  return (
    <div className="animate-fade-in flex gap-8">
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors">
            <ArrowLeft className="w-4 h-4" />返回
          </Link>
          <div className="flex items-center gap-2">
            {id && <MarkdownEditor docId={id} onSaved={handleEditSaved} />}
            <button
              onClick={() => setShowDelete(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 rounded-xl transition-colors"
              title="删除文档"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 可编辑标题 */}
        <div className="group relative">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                className="flex-1 text-3xl font-bold bg-transparent border-b-2 border-primary text-foreground outline-none px-1"
                autoFocus
              />
              <button onClick={saveTitle} className="p-1.5 text-primary hover:bg-primary/10 rounded-lg transition-colors" title="保存">
                <Check className="w-5 h-5" />
              </button>
              <button onClick={cancelTitleEdit} className="p-1.5 text-muted-foreground hover:bg-accent rounded-lg transition-colors" title="取消">
                <X className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold text-foreground">{doc.content}</h1>
              <button
                onClick={startTitleEdit}
                className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-primary hover:bg-accent rounded-lg transition-all"
                title="编辑标题"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        <article className="prose dark:prose-invert max-w-none">
          <BlockRenderer block={doc} />
        </article>
      </div>
      <aside className="hidden lg:block w-56 shrink-0 space-y-6">
        <div className="sticky top-8">
          {id && <DocTree key={'tree-' + refreshKey} docId={id} />}
          <div className="mt-6">{id && <Backlinks key={'bl-' + refreshKey} blockId={id} />}</div>
        </div>
      </aside>

      <ConfirmDialog
        open={showDelete}
        title="删除文档"
        message="此操作不可撤销。文档及其所有内容将被永久删除。"
        confirmLabel={deleting ? '删除中...' : '删除'}
        destructive
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />
    </div>
  )
}
