import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom'
import type { Block, HeadingNode } from '@notefast/core'
import { buildHeadingTree } from '@notefast/core'
import {
  ArrowLeft,
  Trash2,
  Sparkles,
  Loader2,
  Pencil,
  EyeOff,
  Inbox,
  Archive,
  Share2,
  Globe,
  ChevronDown,
  SquarePen,
  PencilLine,
} from 'lucide-react'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import AutoLinkPanel from '../components/AutoLinkPanel'
import MarkdownEditor from '../components/MarkdownEditor'
import TagEditor from '../components/TagEditor'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import ShareDialog, { fetchDocShared } from '../components/ShareDialog'
import { useAiChatOpen } from '../components/Layout'
import { scrollToElement, findScrollableAncestor } from '../lib/scroll'
import { formatRelative, relativeTime } from '../lib/time'
import { formatIndexProgress, pollIndexJob, type IndexJob } from '../hooks/useIndexJob'
import { useEditorDraft } from '../hooks/useEditorDraft'
import { Kbd, Tooltip, useToast } from '../components/ui'

interface Backlink {
  id: number
  source_id: string
  source_content: string
  source_type: string
  ref_type: string
}

/** stale-while-revalidate 降透明的最短延迟：
 * fetch 在此窗口内完成则永远不显示降透明（避免 LAN 快请求下的幽灵闪烁）。
 * 经验值：本地/同机房 fetch 通常 20-60ms，留 120ms 留余量。 */

function countWords(doc: Block): number {
  let n = 0
  const walk = (b: Block) => {
    // 根 document 块的 content 是文档标题而非正文，不计入——
    // 否则标题恒非空，isEmpty 永远为 false（空态不可达），字数也虚高一个标题长
    if (b.content && b.type !== 'document') n += b.content.trim().length
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
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const aiChatOpen = useAiChatOpen()
  const toast = useToast()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [docShared, setDocShared] = useState(false)
  const shareBtnRef = useRef<HTMLButtonElement>(null)

  const [titleDraft, setTitleDraft] = useState('')
  const [generatingTitle, setGeneratingTitle] = useState(false)

  /** 编辑态 — 记录「哪篇文档」在编辑，而非布尔值。
   * 同一条路由（/doc/:id）侧栏切换文档时组件不卸载：布尔方案下编辑态会泄漏到
   * 下一篇（且重置 effect 与新编辑器 onActiveChange(true) 存在时序竞争）；
   * 记录 docId 后，isEditing 对新 id 在渲染期即为 false，编辑器根本不会挂载。
   * edit=1 仅作为深链接口保留（/new 已不再携带）。 */
  const [editingDocId, setEditingDocId] = useState<string | null>(
    searchParams.get('edit') === '1' ? (id ?? null) : null,
  )
  const isEditing = editingDocId !== null && editingDocId === id
  // 离开被编辑的文档后编辑会话结束（未保存内容由 useEditorDraft 草稿保留）
  useEffect(() => {
    if (editingDocId && editingDocId !== id) setEditingDocId(null)
  }, [id, editingDocId])
  const handleEditorActiveChange = useCallback((editing: boolean) => {
    setEditingDocId(editing ? (id ?? null) : null)
  }, [id])
  const handleStartEdit = useCallback(() => setEditingDocId(id ?? null), [id])
  // 阅读态草稿探测：进入文档 / 退出编辑 / 保存刷新后重估（草稿由编辑器的
  // 自动暂存产生，阅读态此前完全无感——看不到「这篇还有未保存内容」）
  const editorDraft = useEditorDraft(id ?? '')
  const [draftInfo, setDraftInfo] = useState<{ updatedAt: number } | null>(null)
  useEffect(() => {
    if (!id || isEditing) return
    setDraftInfo(editorDraft.getDraftInfo())
  }, [id, isEditing, refreshKey, editorDraft])
  const handleEditorMountKey = useMemo(
    () => Math.random().toString(36).slice(2, 10),
    [id, isEditing],
  )
  const [headings, setHeadings] = useState<HeadingNode[]>([])
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [aiExclude, setAiExclude] = useState(false)
  const [aiExcludeSaving, setAiExcludeSaving] = useState(false)
  const [docStatus, setDocStatus] = useState<'note' | 'inbox' | 'archived'>('note')
  const [statusSaving, setStatusSaving] = useState(false)
  const [auxLoading, setAuxLoading] = useState(false)
  const [indexJob, setIndexJob] = useState<IndexJob | null>(null)
  const [showSkeleton, setShowSkeleton] = useState(false)
  // 恢复 AI 可见触发的索引轮询（切换文档/重复点击时中止上一轮）
  const indexJobAcRef = useRef<AbortController | null>(null)
  useEffect(() => () => indexJobAcRef.current?.abort(), [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setError(null)
    setShowSkeleton(false)
    if (doc === null) setLoading(true)

    const skeletonTimer = window.setTimeout(() => {
      if (!cancelled && doc === null) setShowSkeleton(true)
    }, 150)

    api
      .get<Block>('/docs/' + id)
      .then((d) => {
        if (!cancelled) setDoc(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) {
          clearTimeout(skeletonTimer)
          setLoading(false)
          setShowSkeleton(false)
        }
      })
    return () => {
      cancelled = true
      clearTimeout(skeletonTimer)
    }
  }, [id, refreshKey])

  // 分享状态：切换文档时拉取，供顶栏图标区分「已公开」
  useEffect(() => {
    if (!id) {
      setDocShared(false)
      return
    }
    let cancelled = false
    setDocShared(false)
    void fetchDocShared(id).then((shared) => {
      if (!cancelled) setDocShared(shared)
    })
    return () => { cancelled = true }
  }, [id])

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
      setTags((doc.tags ?? []).slice(0, 64))
      setAiExclude(doc.ai_exclude)
      setDocStatus(doc.status === 'inbox' ? 'inbox' : doc.status === 'archived' ? 'archived' : 'note')
    }
  }, [doc])

  useEffect(() => {
    if (!id) return
    setAuxLoading(true)
    request<Backlink[]>(`/search/refs?target_id=${id}`)
      .then(setBacklinks)
      .catch(() => setBacklinks([]))
      .finally(() => setAuxLoading(false))
  }, [id, refreshKey])

  useEffect(() => {
    if (doc) {
      setHeadings(buildHeadingTree(doc.children || []))
    }
  }, [doc])

  // 引用/反链/大纲跳转：文档加载后按 hash 滚动到目标块。
  // 兼容两种形式：引用链接的 #block-<id> 与大纲/heading 锚的 #<id>。
  // SPA 导航时内容分多拍到达（旧文档保留 → 新数据替换 → SSE 再刷新），
  // 单次滚动会落在过期布局上（且并发平滑动画会互相截停）——
  // 瞬时跳 + 两次位置校验补跳，覆盖所有时序。
  useEffect(() => {
    if (!doc) return
    const raw = location.hash.slice(1)
    if (!raw) return
    const targetId = raw.startsWith('block-') ? raw.slice(6) : raw
    // 路由离场叠影（.animate-page-leave）里是旧页快照，含相同 block id 的幽灵节点；
    // getElementById 按文档序会命中幽灵——查找时显式排除
    const findTarget = (): HTMLElement | null => {
      for (const el of document.querySelectorAll(`[id="${targetId}"]`)) {
        if (el instanceof HTMLElement && !el.closest('.animate-page-leave')) return el
      }
      return null
    }
    const jump = () => {
      const el = findTarget()
      if (el) scrollToElement(el, 72, 0)
    }
    const inPlace = () => {
      const el = findTarget()
      if (!el) return false
      const scroller = findScrollableAncestor(el)
      const base = scroller ? scroller.getBoundingClientRect().top : 0
      return Math.abs(el.getBoundingClientRect().top - (base + 72)) < 24
    }
    const timers = [
      window.setTimeout(jump, 60),
      window.setTimeout(() => { if (!inPlace()) jump() }, 400),
      window.setTimeout(() => {
        if (inPlace()) return
        if (findTarget()) jump()
        // 锚点失效（回答生成后文档被编辑/删除，或过期引用）：明确告知而非沉默停在顶部
        else toast.info({ title: '原文块已不存在', description: '该内容可能在此之后被编辑或删除' })
      }, 900),
    ]
    return () => timers.forEach(clearTimeout)
  }, [doc, location.hash])

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
      const res = await api.patch<{ effect?: { index_job?: IndexJob } }>(`/docs/${id}/ai-exclude`, { ai_exclude: next })
      setAiExclude(next)
      setRefreshKey((k) => k + 1)
      // 恢复可见：向量重建已在服务端异步调度，前端复用创建/导入的进度条 + 完成 toast
      const jobId = res.effect?.index_job?.id
      if (!next && jobId) {
        indexJobAcRef.current?.abort()
        const ac = new AbortController()
        indexJobAcRef.current = ac
        void pollIndexJob(jobId, {
          signal: ac.signal,
          onUpdate: (j) => { if (!ac.signal.aborted) setIndexJob(j) },
        }).then((final) => {
          if (ac.signal.aborted) return
          setIndexJob(null)
          if (final.state === 'ready') toast.success({ title: formatIndexProgress(final) })
          else if (final.state === 'partial') toast.warning({ title: formatIndexProgress(final) })
          else if (final.state === 'failed') toast.error({ title: formatIndexProgress(final) })
        }).catch(() => {})
      }
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

  // 归档 ⇄ 恢复：归档后从「所有文档」与 AI 检索默认排除，可随时恢复
  const handleToggleArchive = async () => {
    if (!id || statusSaving) return
    const next = docStatus === 'archived' ? 'note' : 'archived'
    setStatusSaving(true)
    try {
      await api.patch(`/docs/${id}/status`, { status: next })
      setDocStatus(next)
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
      // 软删除 + restore 端点：Undo toast 是 Web 上唯一的恢复入口
      toast.success({
        title: '已删除',
        durationMs: 6000,
        action: {
          label: '撤销',
          onClick: () => {
            void (async () => {
              try {
                await api.post(`/blocks/${id}/restore`, {})
                toast.success({ title: '已恢复' })
              } catch {
                toast.error({ title: '撤销失败' })
              }
            })()
          },
        },
      })
    } catch {
      setDeleting(false)
      setShowDelete(false)
    }
  }

  const flatHeadings = flattenHeadings(headings)
  const updatedAt = doc ? formatRelative(doc.updated_at, 'long') : ''
  const wordCount = doc ? countWords(doc) : 0
  const isEmpty = wordCount === 0

  // 首屏骨架：结构与正式布局一致（header + 内容列 + 右栏），加载完成后布局零跳动
  if (!doc && loading && showSkeleton) {
    return (
      <div className="flex flex-col lg:flex-row h-full animate-pulse">
        <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
          <div className="h-14 shrink-0 border-b border-border/50" />
          <div className="flex-1 overflow-hidden">
            <div className="w-full max-w-4xl mx-auto px-8 pt-10 space-y-3">
              <div className="mx-auto max-w-[var(--reading-max-w)] space-y-3">
                <div className="h-9 bg-secondary rounded w-1/2" />
                <div className="h-3.5 bg-secondary rounded w-28" />
                <div className="h-4 bg-secondary rounded w-full mt-8" />
                <div className="h-4 bg-secondary rounded w-5/6" />
                <div className="h-4 bg-secondary rounded w-4/6" />
              </div>
            </div>
          </div>
        </div>
        <div className="hidden lg:flex lg:flex-col w-72 shrink-0 bg-sidebar/30">
          <div className="h-14 shrink-0 border-b border-border/50" />
        </div>
      </div>
    )
  }

  // 加载中但还没到骨架延迟：空 div 撑住布局，避免 Error 态闪现
  if (!doc && loading) return <div className="flex-1" />

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
            <Tooltip label={docShared ? '已公开分享' : '分享文档'}>
              <button
                ref={shareBtnRef}
                type="button"
                onClick={() => setShowShare((v) => !v)}
                className={`inline-flex items-center justify-center gap-0.5 h-7 rounded-md transition-colors ${
                  docShared
                    ? 'px-1.5 text-foreground bg-muted/70 hover:bg-muted'
                    : 'w-7 text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                aria-expanded={showShare}
                aria-haspopup="dialog"
              >
                {docShared
                  ? <Globe className="w-3.5 h-3.5" strokeWidth={1.75} />
                  : <Share2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
                {docShared && (
                  <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${showShare ? 'rotate-180' : ''}`} strokeWidth={2} />
                )}
              </button>
            </Tooltip>
            <Tooltip label="删除文档">
              <button
                type="button"
                onClick={() => setShowDelete(true)}
                className="btn-icon-ghost text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </div>
        </PageHeader>

        {/* Scrollable Document Body — scrollbar-gutter 预留滚动条位，切换文档时内容不横移 */}
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {/* 切换文档时保留旧内容完整展示，新数据到了直接替换 */}
          <div>
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
            {!isEditing && draftInfo && (
              <div className="mb-6 flex items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <PencilLine className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1">
                  有未保存的草稿{draftInfo.updatedAt > 0 ? `（${relativeTime(new Date(draftInfo.updatedAt))}编辑）` : ''}
                </span>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  onClick={() => { editorDraft.clearDraft(); setDraftInfo(null) }}
                  className="text-muted-foreground/70 hover:text-destructive transition-colors"
                >
                  丢弃
                </button>
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
            {docStatus === 'archived' && (
              <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <Archive className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 min-w-[12rem]">此篇已归档，不出现在「所有文档」，AI 回答默认也不再引用。</span>
                <button
                  type="button"
                  onClick={handleToggleArchive}
                  disabled={statusSaving}
                  className="shrink-0 text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  恢复为笔记
                </button>
                <Link to="/archived" className="shrink-0 text-muted-foreground hover:text-foreground">
                  查看归档
                </Link>
              </div>
            )}
            {/* 阅读列：标题/meta/tags/正文 走 --reading-max-w；状态横幅保留在外层 max-w-4xl */}
            <div className="mx-auto max-w-[var(--reading-max-w)]">
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
            {isEditing && <div className="mb-2" />}

            {/* Tags + 归档/对 AI 隐藏（默认可见，不展示锁图标；仅隐藏态强调） */}
            <div className="flex flex-wrap items-center justify-between gap-3 mt-4 mb-6">
              {id && <TagEditor docId={id} tags={tags} onChange={setTags} />}
              <div className="flex items-center gap-3 shrink-0">
                {docStatus !== 'archived' && (
                  <button
                    type="button"
                    onClick={handleToggleArchive}
                    disabled={statusSaving}
                    className="text-[11.5px] text-muted-foreground/75 hover:text-foreground transition-colors"
                    title="归档后不出现在「所有文档」，AI 回答默认不再引用；可随时恢复"
                  >
                    归档
                  </button>
                )}
                {!aiExclude && (
                  <button
                    type="button"
                    onClick={handleToggleAiExclude}
                    disabled={aiExcludeSaving}
                    className="text-[11.5px] text-muted-foreground/75 hover:text-foreground transition-colors"
                    title="隐藏后不进向量索引 / RAG / AutoLink / MCP（你仍可搜索与编辑）"
                  >
                    对 AI 隐藏
                  </button>
                )}
              </div>
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
                  <div className="px-3 py-14 flex flex-col items-center text-center select-none">
                    <div className="empty-icon-tile">
                      <SquarePen className="w-5 h-5" />
                    </div>
                    <h3 className="text-[15px] font-medium text-foreground mb-1.5">空白文档</h3>
                    <p className="text-[13px] text-muted-foreground max-w-[300px] leading-relaxed flex items-center justify-center gap-1.5 flex-wrap">
                      按下 <Kbd>⌘E</Kbd> 开始写作，或 <Kbd>⌘J</Kbd> 向 AI 提问。
                    </p>
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
      </div>

      {/* Right Sidebar (Desktop only) — AI 聊天打开时让位，避免双栏堆叠的割裂感 */}
      {!aiChatOpen && (
        <div className="hidden lg:flex flex-col w-72 shrink-0 bg-sidebar/30 h-full">
          {/* 顶栏占位：三栏 h-14 水平基准线对齐 */}
          <div className="h-14 shrink-0 border-b border-border/50" />
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            <section>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
                大纲
              </h3>
              <OutlineView headings={flatHeadings} loading={auxLoading} />
            </section>

            <section>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
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
        message="确定要删除这篇文档吗？删除后可在右下角提示中撤销。"
        confirmLabel={deleting ? '删除中...' : '删除'}
        destructive
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />

      {showShare && id && (
        <ShareDialog
          docId={id}
          anchorRef={shareBtnRef}
          onClose={() => setShowShare(false)}
          onSharedChange={setDocShared}
        />
      )}
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