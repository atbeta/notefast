import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { Block, HeadingNode } from '@notefast/core'
import {
  ArrowLeft,
  Trash2,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
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

  const [forceEditKey, setForceEditKey] = useState(0)

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
    <div className="flex flex-col lg:flex-row items-start gap-8 animate-fade-in pb-20">
      {/* Main Content Area */}
      <div className="flex-1 min-w-0 w-full">
        {/* Top actions */}
        <div className="flex items-center justify-between mb-8">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回
          </Link>

          <div className="flex items-center gap-2">
            {id && (
              <MarkdownEditor
                key={`editor-${id}-${forceEditKey}`}
                docId={id}
                onSaved={handleEditSaved}
                autoEdit={searchParams.get('edit') === '1' || forceEditKey > 0}
              />
            )}
            <div className="h-4 w-px bg-border mx-1" />
            <button
              onClick={() => setShowDelete(true)}
              className="btn-icon-ghost text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="删除文档"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Title Area */}
        <div className="group relative mb-6">
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={handleTitleKeyDown}
            className="w-full bg-transparent border-none outline-none font-bold text-[28px] leading-tight tracking-[-0.02em] text-foreground focus:ring-0 px-0 placeholder:text-muted-foreground/40 transition-colors"
            placeholder="无标题文档"
          />
          <button
            type="button"
            onClick={handleSuggestTitle}
            disabled={generatingTitle}
            className="absolute -right-8 top-2 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-all"
            title="AI 生成标题"
          >
            {generatingTitle ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Meta Info */}
        <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-muted-foreground mb-8">
          <span>{updatedAt} 更新</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>{wordCount.toLocaleString('zh-CN')} 字</span>
        </div>

        {/* Content */}
        <div className="relative">
          <div className={'warn-hint mb-6 ' + (isEmpty ? 'show' : '')}>
            文档正文为空 —{' '}
            <button
              onClick={() => setForceEditKey((k) => k + 1)}
              className="underline underline-offset-2 font-medium hover:text-warn transition-colors"
            >
              点此开始写作
            </button>
          </div>

          <article className="prose dark:prose-invert max-w-none">
            <BlockRenderer block={doc} />
          </article>
        </div>
      </div>

      {/* Right Sidebar (Desktop only) */}
      <div className="hidden lg:flex flex-col w-64 shrink-0 space-y-8 sticky top-8">
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">
            大纲
          </h3>
          <OutlineView headings={flatHeadings} loading={auxLoading} />
        </section>

        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">
            反向链接
          </h3>
          <BacklinksView backlinks={backlinks} loading={auxLoading} />
        </section>
      </div>

      {/* Right Sidebar (Mobile stack) */}
      <div className="lg:hidden w-full space-y-8 mt-12 pt-8 border-t border-border">
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-4">大纲</h3>
          <OutlineView headings={flatHeadings} loading={auxLoading} />
        </section>

        <section>
          <h3 className="text-sm font-semibold text-foreground mb-4">反向链接</h3>
          <BacklinksView backlinks={backlinks} loading={auxLoading} />
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
    return <div className="px-2 text-sm text-muted-foreground">加载中...</div>
  }
  if (headings.length === 0) {
    return (
      <div className="px-2 text-sm text-muted-foreground italic">
        暂无目录
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className="px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors truncate"
          style={{ paddingLeft: `${(h.depth * 12) + 8}px` }}
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
    return <div className="px-2 text-sm text-muted-foreground">加载中...</div>
  }
  if (backlinks.length === 0) {
    return (
      <div className="px-2 text-sm text-muted-foreground italic">
        尚无反向链接
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