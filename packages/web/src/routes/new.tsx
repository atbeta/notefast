import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Check, X, Upload, Sparkles, Loader2, Tag, Plus } from 'lucide-react'
import type { Notebook } from '@notefast/core'
import { request } from '../hooks/useAPI'
import PageHeader from '../components/PageHeader'
import SubNavTabs from '../components/SubNavTabs'

function normalizeTag(t: string): string {
  return t.toLowerCase().replace(/\s+/g, '-').slice(0, 64)
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
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
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
      let indexJobId: string | undefined
      if (markdown.trim()) {
        const res = await request<{ doc: { id: string }; index_job?: { id: string } }>('/import/markdown', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, markdown, title: finalTitle, tags }),
        })
        docId = res.doc.id
        indexJobId = res.index_job?.id
      } else {
        const res = await request<{ id: string; index_job?: { id: string } }>('/docs', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, title: finalTitle, tags }),
        })
        docId = res.id
        indexJobId = res.index_job?.id
      }
      // 内容已随创建入库——落地阅读态（不带 edit=1），向量化进度经 index_job 参数照常展示
      const q = new URLSearchParams()
      if (indexJobId) q.set('index_job', indexJobId)
      const qs = q.toString()
      navigate('/doc/' + docId + (qs ? '?' + qs : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
      setCreating(false)
    }
  }

  const handleCancel = () => navigate('/')

  const handleAddTag = () => {
    const normalized = normalizeTag(tagDraft.trim())
    if (!normalized || tags.includes(normalized)) {
      setTagDraft('')
      return
    }
    setTags((prev) => [...prev, normalized].sort())
    setTagDraft('')
  }

  const handleRemoveTag = (tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag))
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddTag()
    } else if (e.key === 'Escape') {
      setTagDraft('')
      e.currentTarget.blur()
    }
  }

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
    <div className="animate-fade-in">
      {/* 全局顶栏：h-14 + 底边框，与侧边栏顶栏贯通 */}
      <PageHeader>
        <SubNavTabs
          embedded
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
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-8 pt-8 pb-16">
      {activeTab === 'create' && (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor="doc-title" className="text-[12px] font-medium text-muted-foreground">标题</label>
              <button
                type="button"
                onClick={handleSuggestTitle}
                disabled={generating || (!markdown.trim() && !title.trim())}
                className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                title="AI 生成标题"
              >
                {generating ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" strokeWidth={1.75} />
                )}
                {generating ? '生成中…' : 'AI 标题'}
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
            <div className="flex items-baseline justify-between mb-2">
              <label htmlFor="doc-markdown" className="text-[12px] font-medium text-muted-foreground">Markdown 内容</label>
              <span className="text-[11.5px] text-muted-foreground/60">可选</span>
            </div>
            <textarea
              id="doc-markdown"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder={'# 从这里开始写\n\n支持 **粗体**、代码块与 [[双向链接]] 占位符\n\n占位符语法会在保存时解析为 block 节点'}
              rows={9}
              className="input-mono"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[12px] font-medium text-muted-foreground">标签</label>
              <span className="text-[11.5px] text-muted-foreground/60">可选</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" strokeWidth={1.75} />
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11.5px] bg-muted/60 text-foreground/85"
                >
                  <span className="font-mono">{t}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(t)}
                    className="w-4 h-4 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive hover:bg-background/60 transition-colors"
                  >
                    <X className="w-3 h-3" strokeWidth={2} />
                  </button>
                </span>
              ))}
              <div className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full border border-dashed border-border/70 hover:border-foreground/30 transition-colors">
                <Plus className="w-3 h-3 text-muted-foreground/60" strokeWidth={2} />
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  onBlur={() => {
                    if (tagDraft.trim()) handleAddTag()
                  }}
                  placeholder="加标签"
                  className="bg-transparent border-none outline-none text-[11.5px] w-16 placeholder:text-muted-foreground/40 focus:w-28 transition-[width] duration-200"
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/8 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/60">
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
        <div className="py-4">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="block border border-dashed border-border-strong/60 rounded-xl text-center py-16 px-6 cursor-pointer hover:border-foreground/30 hover:bg-muted/40 transition-colors"
          >
            <div className="empty-icon-tile mx-auto">
              <Upload className="w-5 h-5" strokeWidth={1.75} />
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