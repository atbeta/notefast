import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileText, Wand2, Check, X, Upload, Sparkles, Loader2 } from 'lucide-react'
import { request } from '../hooks/useAPI'
import SubNavTabs from '../components/SubNavTabs'

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
  const [activeTab, setActiveTab] = useState<'create' | 'import'>('create')
  const [generating, setGenerating] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    request<Notebook[]>('/notebooks')
      .then((list) => { if (list.length > 0) setNotebookId(list[0].id) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    titleInputRef.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setError('')

    const finalTitle = title.trim() || new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })

    try {
      let docId: string
      if (markdown.trim()) {
        const res = await request<{ doc: { id: string } }>('/import/markdown', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, markdown, title: finalTitle }),
        })
        docId = res.doc.id
      } else {
        const res = await request<{ id: string }>('/docs', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, title: finalTitle }),
        })
        docId = res.id
      }
      navigate('/doc/' + docId + '?edit=1')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
      setCreating(false)
    }
  }

  const handleCancel = () => navigate('/')

  const handleSuggestTitle = async () => {
    const source = markdown.trim() || title.trim()
    if (!source || generating) return
    setGenerating(true)
    try {
      const res = await request<{ title: string; summary: string }>('/ai/suggest-title', {
        method: 'POST',
        body: JSON.stringify({ content: source }),
      })
      if (!title.trim()) setTitle(res.title)
      else if (!title.trim().includes(res.title)) setTitle(res.title)
    } catch { /* AI 服务不可用，静默失败 */ }
    finally { setGenerating(false) }
  }

  const handleFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setMarkdown(text)
      if (!title.trim()) setTitle(file.name.replace(/\.md$/i, ''))
      setActiveTab('create')
    }
    reader.readAsText(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="animate-fade-in space-y-6">
      <SubNavTabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'create' | 'import')}
        tabs={[
          { key: 'create', label: '新建文档' },
          { key: 'import', label: '导入 Markdown' },
        ]}
        trailing={
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回</span>
          </Link>
        }
      />

      <div className="card overflow-hidden">
        <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-border">
          <span className="gradient-mark w-7 h-7">
            <FileText className="w-3.5 h-3.5" strokeWidth={2.25} />
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[15px] font-semibold text-foreground leading-tight tracking-[-0.022em]">
              开始一篇新文档
            </h1>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Markdown 原生 · AI 辅助润色与摘要
            </p>
            <div className="mt-2.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border bg-card text-[11px] text-muted-foreground">
                <Wand2 className="w-3 h-3" strokeWidth={2.25} />
                {markdown.trim()
                  ? `已准备 ${markdown.trim().length} 字 Markdown`
                  : '支持 Markdown · 拖入文件直接导入'}
              </span>
            </div>
          </div>
        </div>

        {activeTab === 'create' && (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
            <div>
              <div className="flex items-end justify-between mb-1.5">
                <label htmlFor="doc-title" className="field-label mb-0">标题</label>
                <button
                  type="button"
                  onClick={handleSuggestTitle}
                  disabled={generating || (!markdown.trim() && !title.trim())}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40 transition-colors"
                  title="AI 生成标题"
                >
                  {generating ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Sparkles className="w-3 h-3" />
                  )}
                  {generating ? '生成中...' : 'AI 标题'}
                </button>
              </div>
              <input
                id="doc-title"
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); if (error) setError('') }}
                placeholder="无标题文档"
                className={'input-underline ' + (error ? 'error' : '')}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="doc-markdown" className="field-label mb-0">Markdown 内容</label>
                <span className="text-[11px] text-muted-foreground/70">可选</span>
              </div>
              <textarea
                id="doc-markdown"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={'# 从这里开始写\n\n支持 **粗体**、代码块与 [[双向链接]] 占位符\n\n占位符语法会在保存时解析为 block 节点'}
                rows={10}
                className="input-mono"
              />
            </div>

            {error && (
              <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 px-3 py-2 rounded-btn">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
              <button
                type="button"
                onClick={handleCancel}
                className="btn-ghost-custom"
              >
                <X className="w-3.5 h-3.5" />
                取消
              </button>
              <button
                type="submit"
                disabled={creating}
                className="btn-primary-custom"
              >
                <Check className="w-3.5 h-3.5" strokeWidth={2.25} />
                {creating ? '创建中…' : '创建并打开'}
              </button>
            </div>
          </form>
        )}

        {activeTab === 'import' && (
          <div className="px-6 py-10">
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="block border-2 border-dashed border-border rounded-btn text-center py-12 px-6 cursor-pointer hover:border-primary/60 hover:bg-primary-soft transition-colors"
            >
              <div className="empty-icon-tile mx-auto">
                <Upload className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">拖入 .md 文件到此处</p>
              <p className="text-xs text-muted-foreground">或点击选择文件 · 文件名自动作为标题</p>
              <input
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                }}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  )
}