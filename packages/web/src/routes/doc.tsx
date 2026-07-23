import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { Block, HeadingNode } from '@notefast/core'
import {
  ArrowLeft,
  Trash2,
  Sparkles,
  Loader2,
  Pencil,
  EyeOff,
  Inbox,
} from 'lucide-react'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import AutoLinkPanel from '../components/AutoLinkPanel'
import MarkdownEditor from '../components/MarkdownEditor'
import TagEditor from '../components/TagEditor'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import { useAiChatOpen } from '../components/Layout'
import { scrollToElement } from '../lib/scroll'
import { formatRelative } from '../lib/time'
import { formatIndexProgress, pollIndexJob, type IndexJob } from '../hooks/useIndexJob'
import { useToast } from '../components/ui'

interface Backlink {
  id: number
  source_id: string
  source_content: string
  source_type: string
  ref_type: string
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
  const [searchParams, setSearchParams] = useSearchParams()
  const aiChatOpen = useAiChatOpen()
  const toast = useToast()
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
  const [tags, setTags] = useState<string[]>([])
  const [aiExclude, setAiExclude] = useState(false)
  const [aiExcludeSaving, setAiExcludeSaving] = useState(false)
  const [docStatus, setDocStatus] = useState<'note' | 'inbox'>('note')
  const [statusSaving, setStatusSaving] = useState(false)
  const [auxLoading, setAuxLoading] = useState(false)
  const [indexJob, setIndexJob] = useState<IndexJob | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    api.get<Block>('/docs/' + id).then(setDoc).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [id, refreshKey])

  // 创建/导入后的向量化进度（?index_job=）
  useEffect(() => {
    const jobId = searchParams.get('index_job')
    if (!jobId) {
      setIndexJob(null)
      return
    }
    const ac = new AbortController()
    void pollIndexJob(jobId, {
      signal: ac.signal,
      onUpdate: setIndexJob,
    }).then((final) => {
      if (ac.signal.aborted) return
      setIndexJob(final)
      if (final.state === 'ready') {
        toast.success({ title: formatIndexProgress(final) })
      } else if (final.state === 'partial') {
        toast.warning({ title: formatIndexProgress(final) })
      } else if (final.state === 'failed') {
        toast.error({ title: formatIndexProgress(final) })
      }
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('index_job')
        return next
      }, { replace: true })
      setIndexJob(null)
    }).catch(() => {})
    return () => ac.abort()
  }, [id, searchParams, setSearchParams, toast])

  useEffect(() => {
    if (doc) {
      setTitleDraft(doc.content)
      // 从 properties JSON 同步 tag / ai_exclude / status
      const raw = (doc as Block & { properties?: unknown }).properties
      if (raw && typeof raw === 'object') {
        const props = raw as Record<string, unknown>
        const arr = props.tags
        if (Array.isArray(arr)) {
          setTags(arr.filter((t): t is string => typeof t === 'string').slice(0, 64))
        } else {
          setTags([])
        }
        setAiExclude(props.ai_exclude === true)
        setDocStatus(props.status === 'inbox' ? 'inbox' : 'note')
      } else {
        setTags([])
        setAiExclude(false)
        setDocStatus('note')
      }
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
    if (!doc || generatingTitle || aiExclude) return
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

  const handleToggleAiExclude = async () => {
    if (!id || aiExcludeSaving) return
    setAiExcludeSaving(true)
    try {
      const next = !aiExclude
      await api.patch(`/docs/${id}/ai-exclude`, { ai_exclude: next })
      setAiExclude(next)
      setRefreshKey((k) => k + 1)
    } catch { /* silent */ }
    finally { setAiExcludeSaving(false) }
  }

  const handlePromoteFromInbox = async () => {
    if (!id || statusSaving || docStatus !== 'inbox') return
    setStatusSaving(true)
    try {
      await api.patch(`/docs/${id}/status`, { status: 'note' })
      setDocStatus('note')
      setRefreshKey((k) => k + 1)
    } catch { /* silent */ }
    finally { setStatusSaving(false) }
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

  const flatHeadings = flattenHeadings(headings)
  const updatedAt = doc ? formatRelative(doc.updated_at, 'long') : ''
  const wordCount = doc ? countWords(doc) : 0
  const isEmpty = wordCount === 0
  /** 正在显示的是旧文档（A），新文档（B）还在拉取中 —— stale-while-revalidate */
  const showingStale = doc !== null && doc.id !== id

  // 首屏骨架：结构与正式布局一致（header + 内容列 + 右栏），加载完成后布局零跳动
  if (!doc && loading) {
    return (
      <div className="flex flex-col lg:flex-row h-full animate-pulse">
        <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
          <div className="h-14 shrink-0 border-b border-border/50" />
          <div className="flex-1 overflow-hidden">
            <div className="w-full max-w-4xl mx-auto px-8 pt-10 space-y-3">
              <div className="h-9 bg-secondary rounded w-1/2" />
              <div className="h-3.5 bg-secondary rounded w-28" />
              <div className="h-4 bg-secondary rounded w-full mt-8" />
              <div className="h-4 bg-secondary rounded w-5/6" />
              <div className="h-4 bg-secondary rounded w-4/6" />
            </div>
          </div>
        </div>
        <div className="hidden lg:flex lg:flex-col w-72 shrink-0 bg-sidebar/30">
          <div className="h-14 shrink-0 border-b border-border/50" />
        </div>
      </div>
    )
  }

  if (!doc) return <ErrorState message={error || '文档不存在'} />

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
        {/* Global Sticky Header */}
        <PageHeader bare className="shrink-0 flex items-center justify-between px-6">
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
          <div className="flex items-center gap-2">
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
            {isEditing && (
              <span
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
                title="编辑内容会自动保存到本地草稿，⌘S 写入知识库"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                编辑中
              </span>
            )}
            <div className="w-px h-4 bg-border/60 mx-1" />
            <button
              type="button"
              onClick={() => setShowDelete(true)}
              className="btn-icon-ghost text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="删除文档"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </PageHeader>

        {/* Scrollable Document Body — scrollbar-gutter 预留滚动条位，切换文档时内容不横移 */}
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {/* stale-while-revalidate：切换文档时保留旧内容降透明，新文档就地替换，无闪烁 */}
          <div className={`transition-opacity duration-200 ${showingStale ? 'opacity-40' : 'opacity-100'}`}>
            <div className="w-full max-w-4xl mx-auto px-8 pt-14 pb-32 animate-fade-in">
            {indexJob && (indexJob.state === 'pending' || indexJob.state === 'running') && (
              <div className="mb-6 flex items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" strokeWidth={1.75} />
                <span className="flex-1">{formatIndexProgress(indexJob)}</span>
                <span className="tabular-nums text-[11px]">
                  {(indexJob.elapsed_ms / 1000).toFixed(1)}s
                </span>
              </div>
            )}
            {docStatus === 'inbox' && (
              <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <Inbox className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 min-w-[12rem]">此篇在收集箱中，不会出现在「所有文档」。整理好后可加入笔记。</span>
                <button
                  type="button"
                  onClick={handlePromoteFromInbox}
                  disabled={statusSaving}
                  className="shrink-0 text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  加入笔记
                </button>
                <Link to="/inbox" className="shrink-0 text-muted-foreground hover:text-foreground">
                  返回收集箱
                </Link>
              </div>
            )}
            {/* Title — always editable, AI-generate on hover */}
            <div className="group relative">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={handleTitleKeyDown}
                className="input-underline font-bold text-foreground"
                placeholder="无标题文档"
              />
              <button
                type="button"
                onClick={handleSuggestTitle}
                disabled={generatingTitle || aiExclude}
                className="absolute -right-8 top-3 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-foreground transition-all rounded disabled:opacity-30"
                title={aiExclude ? '已对 AI 隐藏，无法生成标题' : 'AI 生成标题'}
              >
                {generatingTitle ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" strokeWidth={1.75} />
                )}
              </button>
            </div>

            {/* Meta row — 阅读态展示，融入标题与正文之间 */}
            {!isEditing && (
              <div className="mt-2 mb-8 text-[12px] text-muted-foreground/70 tabular-nums select-none">
                {wordCount.toLocaleString('zh-CN')} 字
                {updatedAt && (
                  <>
                    <span className="mx-2 text-border-strong">·</span>
                    更新于 {updatedAt}
                  </>
                )}
              </div>
            )}
            {!isEditing && (
              <button
                type="button"
                onClick={handleStartEdit}
                className="inline-flex items-center gap-1.5 mt-1 mb-4 px-3 py-1.5 rounded-md border border-border/70 bg-card hover:border-foreground/30 hover:text-foreground text-[13px] font-medium text-muted-foreground transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                编辑文档
              </button>
            )}
            {isEditing && <div className="mb-2" />}

            {/* Tags + 对 AI 隐藏（默认可见，不展示锁图标；仅隐藏态强调） */}
            <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
              {id && <TagEditor docId={id} tags={tags} onChange={setTags} />}
              {!aiExclude && (
                <button
                  type="button"
                  onClick={handleToggleAiExclude}
                  disabled={aiExcludeSaving}
                  className="shrink-0 text-[11.5px] text-muted-foreground/75 hover:text-foreground transition-colors"
                  title="隐藏后不进向量索引 / RAG / AutoLink / MCP（你仍可搜索与编辑）"
                >
                  对 AI 隐藏
                </button>
              )}
            </div>

            {aiExclude && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground/80 leading-relaxed">
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-foreground/80">
                  <EyeOff className="w-3 h-3 shrink-0" strokeWidth={1.75} />
                  已对 AI 隐藏
                </span>
                <span>不会被索引、对话检索或 AutoLink；MCP 也无法读取。你仍可在 Web 中搜索与编辑。</span>
                <button
                  type="button"
                  onClick={handleToggleAiExclude}
                  disabled={aiExcludeSaving}
                  className="text-foreground/90 underline underline-offset-2 hover:text-foreground"
                >
                  恢复对 AI 可见
                </button>
              </div>
            )}
            {/* Editor — 与阅读态同宽，融入文档流 */}
            {id && isEditing && (
              <MarkdownEditor
                key={handleEditorMountKey}
                docId={id}
                title={doc.content}
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
      </div>

      {/* Right Sidebar (Desktop only) — AI 聊天打开时让位，避免双栏堆叠的割裂感 */}
      {!aiChatOpen && (
        <div className={`hidden lg:flex flex-col w-72 shrink-0 bg-sidebar/30 h-full transition-opacity duration-200 ${showingStale ? 'opacity-40' : 'opacity-100'}`}>
          {/* 顶栏占位：三栏 h-14 水平基准线对齐 */}
          <div className="h-14 shrink-0 border-b border-border/50" />
          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            <section>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-3">
                大纲
              </h3>
              <OutlineView headings={flatHeadings} loading={auxLoading} />
            </section>

            <section>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-3">
                反向链接
              </h3>
              <BacklinksView backlinks={backlinks} loading={auxLoading} />
            </section>

            <section>
              {aiExclude ? (
                <div className="text-[12px] text-muted-foreground leading-relaxed">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
                    AutoLink
                  </h3>
                  本篇已对 AI 隐藏，不会生成或展示自动链接建议。
                </div>
              ) : (
                <AutoLinkPanel docId={id ?? null} onClose={() => undefined} />
              )}
            </section>
          </div>
        </div>
      )}

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
          {aiExclude ? (
            <div className="text-[12px] text-muted-foreground leading-relaxed">
              <h3 className="text-sm font-medium text-foreground mb-2">AutoLink</h3>
              本篇已对 AI 隐藏，不会生成或展示自动链接建议。
            </div>
          ) : (
            <AutoLinkPanel docId={id ?? null} onClose={() => undefined} />
          )}
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
  // 仅首次加载（无数据）时显示加载态；切换文档时保留旧大纲直至新数据到达，避免闪烁
  if (loading && headings.length === 0) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">加载中…</div>
  }
  if (headings.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        无标题章节
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          onClick={(e) => {
            e.preventDefault()
            // heading id = block.id（见 BlockRenderer）；手动 rAF 平滑滚动，规避部分环境原生 smooth 失效
            const el = document.getElementById(h.id)
            if (el) scrollToElement(el)
            history.replaceState(null, '', `#${h.id}`)
          }}
          className="px-1.5 -mx-1.5 py-1 text-[12px] text-muted-foreground/85 hover:text-foreground rounded transition-colors truncate"
          style={{ paddingLeft: `${(h.depth * 12) + 6}px` }}
          title={h.content}
        >
          {h.content}
        </a>
      ))}
    </div>
  )
}

function BacklinksView({ backlinks, loading }: { backlinks: Backlink[]; loading: boolean }) {
  if (loading && backlinks.length === 0) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">加载中…</div>
  }
  if (backlinks.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        还没有文档引用此处
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {backlinks.map((bl) => (
        <Link
          key={bl.id}
          to={'/doc/' + bl.source_id}
          className="group block px-2.5 py-2 -mx-1 rounded-lg hover:bg-accent transition-colors"
        >
          <div className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-primary/80 mb-0.5">
            {bl.ref_type}
          </div>
          <p className="text-[12.5px] text-muted-foreground group-hover:text-foreground line-clamp-2 leading-relaxed transition-colors">
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