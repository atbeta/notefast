import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { Block, HeadingNode } from '@notefast/core'
import {
  ArrowLeft,
  Trash2,
  Sparkles,
  Loader2,
  Pencil,
} from 'lucide-react'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import AutoLinkPanel from '../components/AutoLinkPanel'
import MarkdownEditor from '../components/MarkdownEditor'
import ConfirmDialog from '../components/ConfirmDialog'

interface Backlink {
  id: number
  source_id: string
  source_content: string
  source_type: string
  ref_type: string
}

function formatTime(iso: string): string {
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return ''
  const now = Date.now()
  const diff = now - t.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 60 * 24) return `${Math.floor(min / 60)} 小时前`
  if (min < 60 * 24 * 7) return `${Math.floor(min / (60 * 24))} 天前`
  return t.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

function countWords(doc: Block): number {
  let n = 0
  const walk = (b: Block) => {
    if (b.content) n += b.content.trim().length
    b.children.forEach(walk)
  }
  walk(doc)
  return n
}

function flattenHeadings(nodes: HeadingNode[]): Array<HeadingNode & { depth: number }> {
  const out: Array<HeadingNode & { depth: number }> = []
  const walk = (n: HeadingNode, d: number) => {
    out.push({ ...n, depth: d })
    n.children.forEach((c) => walk(c, d + 1))
  }
  nodes.forEach((n) => walk(n, 0))
  return out
}

export default function DocPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [titleDraft, setTitleDraft] = useState('')
  const [generatingTitle, setGeneratingTitle] = useState(false)

  /** 编辑态 — 这是唯一的 truth 来源。
   * MarkdownEditor 的 onActiveChange 通过这条 single source 同步；
   * 由于 docId 在 URL 里，状态在跨页面时不持久（保留为暂态）。 */
  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1')
  const handleEditorActiveChange = useCallback((editing: boolean) => {
    setIsEditing(editing)
  }, [])
  const handleStartEdit = useCallback(() => setIsEditing(true), [])
  const handleEditorMountKey = useMemo(
    () => Math.random().toString(36).slice(2, 10),
    [id, isEditing],
  )
  const [headings, setHeadings] = useState<HeadingNode[]>([])
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [auxLoading, setAuxLoading] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    api.get<Block>('/docs/' + id).then(setDoc).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [id, refreshKey])

  useEffect(() => {
    if (doc) {
      setTitleDraft(doc.content)
    }
  }, [doc])

  useEffect(() => {
    if (!id) return
    setAuxLoading(true)
    Promise.all([
      request<HeadingNode[]>(`/docs/tree?doc_id=${id}`).catch(() => [] as HeadingNode[]),
      request<Backlink[]>(`/search/refs?target_id=${id}`).catch(() => [] as Backlink[]),
    ])
      .then(([tree, refs]) => { setHeadings(tree); setBacklinks(refs) })
      .finally(() => setAuxLoading(false))
  }, [id, refreshKey])

  const handleEditSaved = useCallback(() => { setRefreshKey((k) => k + 1) }, [])

  const saveTitle = async () => {
    if (!id || !doc || titleDraft.trim() === doc.content) return
    const newTitle = titleDraft.trim() || '未命名文档'
    try {
      await api.patch('/blocks/' + id, { content: newTitle })
      setRefreshKey((k) => k + 1)
    } catch {
      setTitleDraft(doc.content) // revert on error
    }
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { 
      e.preventDefault(); 
      e.currentTarget.blur() 
    }
    if (e.key === 'Escape') {
      setTitleDraft(doc?.content || '')
      e.currentTarget.blur()
    }
  }

  const handleSuggestTitle = async () => {
    if (!doc || generatingTitle) return
    const texts: string[] = []
    const walk = (b: Block) => { if (b.content && b.type !== 'document') texts.push(b.content); b.children.forEach(walk) }
    walk(doc)
    const body = texts.join('\n')
    if (!body.trim()) return

    setGeneratingTitle(true)
    try {
      const res = await request<{ title: string; summary: string }>('/ai/suggest-title', {
        method: 'POST',
        body: JSON.stringify({ content: body.slice(0, 4000) }),
      })
      if (res.title && (!doc.content || doc.content === '未命名文档' || doc.content.match(/^\d+月\d+日$/))) {
        await api.patch('/blocks/' + id, { content: res.title })
        setRefreshKey((k) => k + 1)
      }
    } catch { /* silent fail */ }
    finally { setGeneratingTitle(false) }
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
      <div className="flex gap-8 animate-pulse">
        <div className="flex-1 space-y-4">
          <div className="h-4 bg-secondary rounded w-24 mb-8" />
          <div className="h-10 bg-secondary rounded w-1/2" />
          <div className="card p-6 space-y-3 mt-6">
            <div className="h-4 bg-secondary rounded w-full" />
            <div className="h-4 bg-secondary rounded w-5/6" />
            <div className="h-4 bg-secondary rounded w-4/6" />
          </div>
        </div>
      </div>
    )
  }

  if (error) return <ErrorState message={error} />
  if (!doc) return <ErrorState message="文档不存在" />

  const flatHeadings = flattenHeadings(headings)
  const updatedAt = formatTime(doc.updated_at)
  const wordCount = countWords(doc)
  const isEmpty = wordCount === 0

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
        {/* Global Sticky Header */}
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border/50 bg-background/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-4 text-sm">
            <Link
              to="/"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              所有文档
            </Link>
            <span className="text-border-strong">/</span>
            <span className="font-medium text-foreground truncate max-w-[200px] lg:max-w-[400px]">
              {doc.content || '无标题文档'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!isEditing && (
              <div className="hidden sm:flex items-center gap-3 text-[12px] text-muted-foreground/80 font-mono">
                <span>{wordCount.toLocaleString('zh-CN')} words</span>
                <span>updated {updatedAt}</span>
              </div>
            )}
            {isEditing && (
              <div className="text-[12px] text-muted-foreground/80 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span>编辑中 · 自动保存</span>
              </div>
            )}
            <div className="w-px h-4 bg-border/50 mx-1" />
            {!isEditing && (
              <button
                type="button"
                onClick={handleStartEdit}
                className="btn-ghost-custom text-muted-foreground hover:text-foreground"
                title="进入编辑"
              >
                <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                <span>编辑</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowDelete(true)}
              className="btn-icon-ghost text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="删除文档"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Scrollable Document Body */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-12 pb-32 animate-fade-in">
            {/* Title — always editable, AI-generate on hover */}
            <div className="group relative mb-8">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={handleTitleKeyDown}
                className="input-underline text-[34px] font-bold text-foreground"
                placeholder="无标题文档"
              />
              <button
                type="button"
                onClick={handleSuggestTitle}
                disabled={generatingTitle}
                className="absolute -right-8 top-3 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-foreground transition-all rounded"
                title="AI 生成标题"
              >
                {generatingTitle ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" strokeWidth={1.75} />
                )}
              </button>
            </div>

            {/* Editor — full-width block when editing, hides during read */}
            {id && isEditing && (
              <MarkdownEditor
                key={handleEditorMountKey}
                docId={id}
                onSaved={handleEditSaved}
                autoEdit={true}
                onActiveChange={handleEditorActiveChange}
              />
            )}

            {/* Content */}
            {!isEditing && (
              <div className="relative">
                {isEmpty && (
                  <div className="py-4 text-[13px] text-muted-foreground">
                    按下 <kbd className="font-mono text-[11px] px-1 py-px border border-border rounded bg-muted/50 text-foreground">⌘E</kbd> 或点击右上角编辑开始写作。
                  </div>
                )}

                <article>
                  <BlockRenderer block={doc} />
                </article>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Sidebar (Desktop only) */}
      <div className="hidden lg:flex flex-col w-72 shrink-0 bg-sidebar/30 h-full overflow-y-auto">
        <div className="p-6 space-y-8">
          <section>
            <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-3 flex items-center gap-2">
              <span className="w-3 h-px bg-border-strong" /> 大纲
            </h3>
            <OutlineView headings={flatHeadings} loading={auxLoading} />
          </section>

          <section>
            <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-3 flex items-center gap-2">
              <span className="w-3 h-px bg-border-strong" /> 反向链接
            </h3>
            <BacklinksView backlinks={backlinks} loading={auxLoading} />
          </section>

          <section>
            <AutoLinkPanel docId={id ?? null} onClose={() => undefined} />
          </section>
        </div>
      </div>

      {/* Right Sidebar (Mobile stack) */}
      <div className="lg:hidden w-full space-y-8 mt-12 pt-8 border-t border-border">
        <section>
          <h3 className="text-sm font-medium text-foreground mb-3">大纲</h3>
          <OutlineView headings={flatHeadings} loading={auxLoading} />
        </section>

        <section>
          <h3 className="text-sm font-medium text-foreground mb-3">反向链接</h3>
          <BacklinksView backlinks={backlinks} loading={auxLoading} />
        </section>

        <section>
          <AutoLinkPanel docId={id ?? null} onClose={() => undefined} />
        </section>
      </div>

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

function OutlineView({
  headings, loading
}: { headings: Array<HeadingNode & { depth: number }>; loading: boolean }) {
  if (loading) {
    return <div className="px-2 text-[12.5px] text-muted-foreground">加载中...</div>
  }
  if (headings.length === 0) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground/70 italic leading-relaxed border border-dashed border-border/60 rounded-md">
        文档无标题章节
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className="px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors truncate"
          style={{ paddingLeft: `${(h.depth * 10) + 8}px` }}
          title={h.content}
        >
          {h.content}
        </a>
      ))}
    </div>
  )
}

function BacklinksView({ backlinks, loading }: { backlinks: Backlink[]; loading: boolean }) {
  if (loading) {
    return <div className="px-2 text-[12.5px] text-muted-foreground">加载中...</div>
  }
  if (backlinks.length === 0) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground/70 italic leading-relaxed border border-dashed border-border/60 rounded-md">
        还没有文档引用此处
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {backlinks.map((bl) => (
        <Link
          key={bl.id}
          to={'/doc/' + bl.source_id}
          className="group block p-3 rounded-xl border border-border bg-card hover:border-primary/30 hover:shadow-sm transition-all"
        >
          <div className="text-xs font-medium text-primary mb-1">
            {bl.ref_type}
          </div>
          <p className="text-[13px] text-muted-foreground group-hover:text-foreground line-clamp-2 leading-relaxed transition-colors">
            {bl.source_content}
          </p>
        </Link>
      ))}
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card text-center py-16 px-6 animate-fade-in">
      <p className="text-destructive mb-4">{message}</p>
      <Link to="/" className="text-primary hover:underline text-sm inline-flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        返回首页
      </Link>
    </div>
  )
}