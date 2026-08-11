import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { Block, HeadingNode } from '@notefast/core'
import { buildHeadingTree } from '@notefast/core'
import {
  ArrowLeft,
  ArrowRight,
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
  ChevronRight,
  SquarePen,
  PencilLine,
  Network,
  Download,
  PanelRightClose,
  PanelLeftOpen,
  Minimize2,
  Maximize2,
  Presentation,
} from 'lucide-react'
import i18next from '../i18n'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import MarkdownEditor from '../components/MarkdownEditor'
import TagEditor from '../components/TagEditor'
import ConfirmDialog from '../components/ConfirmDialog'
import { useDocContextMenu } from '../components/editor/DocContextMenu'
import EntityPanel from '../components/EntityPanel'
import PageHeader from '../components/PageHeader'
import ShareDialog, { fetchDocShared } from '../components/ShareDialog'
import { useAiChatOpen } from '../components/Layout'
import { readDocRailCollapsed, writeDocRailCollapsed } from '../hooks/useDocRailCollapsed'
import { readDocRailWidth, writeDocRailWidth, type DocRailWidth } from '../hooks/useDocRailWidth'

import { scrollToElement, findScrollableAncestor } from '../lib/scroll'
import { useActiveHeading } from '../hooks/useActiveHeading'
import { useDemoMode, DEMO_ZOOMS, cycleDemoZoom, resetDemoZoom, setDemoZoomIndex } from '../hooks/useDemoMode'
import { formatRelative, relativeTime, formatSqliteDateTime, currentLocale } from '../lib/time'
import { formatIndexProgress, pollIndexJob, type IndexJob } from '../hooks/useIndexJob'
import { useEditorDraft } from '../hooks/useEditorDraft'
import { Kbd, Tooltip, useToast } from '../components/ui'
import { deliverExport, fetchDocExportFile } from '../lib/download'
import { recordVisit } from '../lib/recentVisits'
import { useAiCapabilities } from '../hooks/useAiCapabilities'

interface DocNeighbor {
  id: string
  title: string
}

interface Backlink {
  id: number
  source_id: string
  source_root_id: string
  source_doc_title: string | null
  source_content: string
  source_type: string
  ref_type: string
}

interface DocRevision {
  kind: 'block' | 'snapshot'
  block_id: string
  rev: number
  content: string
  actor: string
  created_at: string
  /** 合成条目：当前文档最新状态，仅展示 diff、不可回退 */
  is_current?: boolean
}

/** revision 在历史面板的稳定 key（block + rev 唯一） */
function revisionKey(rev: DocRevision): string {
  return `${rev.block_id}#${rev.rev}`
}

/** 来源标签：actor → 可读文案（快照与块级都显示修改来源） */
function actorLabel(rev: DocRevision): string {
  switch (rev.actor) {
    case 'current': return i18next.t('doc.revisionActionCurrent')
    case 'revert': return i18next.t('doc.revisionActionRevert')
    case 'ai': return i18next.t('doc.revisionActionAi')
    case 'mcp': return i18next.t('doc.revisionActionMcp')
    case 'editor': return i18next.t('doc.revisionActionEditor')
    case 'user': return i18next.t('doc.revisionActionDirect')
    default: return rev.actor || i18next.t('doc.revisionActionEdit')
  }
}

/** 行级 diff（LCS）：对比两条 markdown，返回变化行（added=绿 / removed=红），用于历史快照对比 */
interface DiffLine { type: 'same' | 'added' | 'removed'; text: string }
function lineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const m = aLines.length
  const n = bLines.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（从尾部递推，便于回溯）
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1]! + 1 : Math.max(dp[i + 1][j]!, dp[i][j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: 'same', text: aLines[i]! })
      i++; j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'removed', text: aLines[i]! })
      i++
    } else {
      out.push({ type: 'added', text: bLines[j]! })
      j++
    }
  }
  while (i < m) out.push({ type: 'removed', text: aLines[i++]! })
  while (j < n) out.push({ type: 'added', text: bLines[j++]! })
  return out
}

/** 折叠相同行（只显示变化及其上下文），控制展开体积 */
function summarizeDiff(lines: DiffLine[], context = 2): DiffLine[] {
  const changedIdx = new Set<number>()
  lines.forEach((l, idx) => {
    if (l.type !== 'same') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) changedIdx.add(k)
    }
  })
  return lines.filter((_, idx) => changedIdx.has(idx))
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
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const ai = useAiCapabilities()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [exporting, setExporting] = useState(false)
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

  /** 右上角导出：与列表菜单共用 fetch + 交付逻辑，按壳形态下载或另存为 */
  const handleExport = async () => {
    if (!id || exporting) return
    setExporting(true)
    try {
      const { blob, filename } = await fetchDocExportFile(id, doc?.content ?? '')
      const delivery = await deliverExport(blob, filename)
      if (delivery.mode === 'saved') {
        toast.success({ title: t('doc.exportedTo', { path: delivery.savedPath }) })
      } else if (delivery.mode === 'downloaded') {
        toast.success({
          title: filename.endsWith('.zip') ? t('doc.exportedWithImages') : t('doc.exportedMarkdown'),
        })
      }
    } catch (err) {
      toast.error({
        title: t('doc.exportFailed'),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setExporting(false)
    }
  }
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
  /** 桌面右栏：大纲 / 链接 / 实体 / 相关 / 历史；切换文档时保持 Tab（相关 Tab 会重拉） */
  const [railTab, setRailTab] = useState<'outline' | 'backlinks' | 'entities' | 'related' | 'history'>('outline')
  /** 相关笔记：打开文档即预取，点 Tab 时尽量秒出 */
  const [relatedItems, setRelatedItems] = useState<RelatedDocItem[] | null>(null)
  const [relatedError, setRelatedError] = useState<string | null>(null)
  const [relatedLoading, setRelatedLoading] = useState(false)
  /** 桌面右栏收起状态（localStorage 记忆；写路径广播给 GlobalSyncStatus 等避让方） */
  const [railCollapsed, setRailCollapsed] = useState(readDocRailCollapsed)
  useEffect(() => {
    writeDocRailCollapsed(railCollapsed)
  }, [railCollapsed])
  /** 桌面右栏宽度档位：normal=288 / wide=400（默认回归旧值，展开对齐聊天窗默认态）；折叠态忽略 */
  const [railWidth, setRailWidth] = useState<DocRailWidth>(readDocRailWidth)
  useEffect(() => {
    writeDocRailWidth(railWidth)
  }, [railWidth])
  /** 演示模式：整体 zoom 放大 + 左侧隐藏（Layout 处理）+ 右栏默认折叠可展开 */
  const demo = useDemoMode()
  /** 演示模式下右栏是否展开（不持久化；演示默认折叠，用户可手动展开） */
  const [demoRailOpen, setDemoRailOpen] = useState(false)
  /** 右栏实际折叠态：演示模式用内存态（默认折叠），平时用持久化态 */
  const railActuallyCollapsed = demo.active ? !demoRailOpen : railCollapsed
  const toggleRailCollapsed = () => {
    if (demo.active) setDemoRailOpen((v) => !v)
    else setRailCollapsed((v) => !v)
  }
  const aiChatOpen = useAiChatOpen()
  /** 移动端目录折叠 */
  const [tocOpen, setTocOpen] = useState(false)
  useEffect(() => { setTocOpen(false) }, [id])
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
        if (!cancelled) {
          setDoc(d)
          // 本机最近访问足迹（侧栏用）；读成功才记，404/失败不污染列表
          recordVisit(id)
        }
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

  // 上一篇/下一篇（Obsidian 式顺序导航，按创建顺序）——顶栏箭头用
  const [neighbors, setNeighbors] = useState<{ prev: DocNeighbor | null; next: DocNeighbor | null }>({ prev: null, next: null })
  useEffect(() => {
    if (!id) {
      setNeighbors({ prev: null, next: null })
      return
    }
    let cancelled = false
    setNeighbors({ prev: null, next: null })
    void api
      .get<{ prev: DocNeighbor | null; next: DocNeighbor | null }>(`/docs/${id}/neighbors`)
      .then((n) => { if (!cancelled) setNeighbors(n) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id])

  // 相关笔记预取（打开文档即拉；轻量检索，点 Tab 尽量无等待）
  useEffect(() => {
    if (!id) {
      setRelatedItems(null)
      setRelatedError(null)
      setRelatedLoading(false)
      return
    }
    let cancelled = false
    setRelatedItems(null)
    setRelatedError(null)
    setRelatedLoading(true)
    api
      .get<{ items: RelatedDocItem[] }>(`/docs/${id}/related?limit=8`)
      .then((res) => {
        if (!cancelled) setRelatedItems(Array.isArray(res?.items) ? res.items : [])
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRelatedError(e instanceof Error ? e.message : String(e))
          setRelatedItems([])
        }
      })
      .finally(() => {
        if (!cancelled) setRelatedLoading(false)
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

  /** 文档历史 revision（跨块时间线）；历史面板打开时才拉取，避免每开文档都查 */
  const [revisions, setRevisions] = useState<DocRevision[]>([])
  const [revisionsLoading, setRevisionsLoading] = useState(false)
  const loadRevisions = useCallback(() => {
    if (!id) return
    setRevisionsLoading(true)
    request<{ revisions: DocRevision[] }>(`/docs/${id}/revisions`)
      .then((r) => setRevisions(r.revisions ?? []))
      .catch(() => setRevisions([]))
      .finally(() => setRevisionsLoading(false))
  }, [id])
  useEffect(() => {
    if (railTab === 'history') loadRevisions()
  }, [railTab, loadRevisions])

  /** 历史面板打开时，任何写入（显式/自动保存）后即刻刷新——面板收起时为空操作 */
  const reloadHistoryIfOpen = useCallback(() => {
    if (railTab === 'history') loadRevisions()
  }, [railTab, loadRevisions])

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
    // 跨路由进场时 RouteTransition 的离场叠影（.animate-page-leave）里可能并行挂载着
    // 同一路由的另一个实例，含相同 block id 的幽灵节点；getElementById 按文档序会命中幽灵——查找时显式排除
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
        else toast.info({ title: t('doc.blockNotFound'), description: t('doc.blockNotFoundDescription') })
      }, 900),
    ]
    return () => timers.forEach(clearTimeout)
  }, [doc, location.hash])

  const handleEditSaved = useCallback(() => {
    setRefreshKey((k) => k + 1)
    reloadHistoryIfOpen()
  }, [reloadHistoryIfOpen])

  const saveTitle = async () => {
    if (!id || !doc || titleDraft.trim() === doc.content) return
    const newTitle = titleDraft.trim() || t('doc.untitledDocument')
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
    if (!ai.chat) {
      toast.info({ title: t('doc.generateTitleNeedChat') })
      return
    }
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
      if (res.title && (!doc.content || doc.content === t('doc.untitledDocument') || doc.content.match(/^\d+月\d+日$/))) {
        await api.patch('/blocks/' + id, { content: res.title })
        setRefreshKey((k) => k + 1)
      }
    } catch {
      toast.error({ title: t('doc.generateTitleNeedChat') })
    }
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
        title: t('doc.deleted'),
        durationMs: 6000,
        action: {
          label: t('doc.undo'),
          onClick: () => {
            void (async () => {
              try {
                await api.post(`/blocks/${id}/restore`, {})
                toast.success({ title: t('doc.restored') })
              } catch {
                toast.error({ title: t('doc.undoFailed') })
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
  // 滚动联动 outline 高亮：传入 heading id 列表，hook 返回当前可见的顶部 heading。
  const scrollActiveHeadingId = useActiveHeading(flatHeadings.map((h) => h.id))
  // 点击大纲项时立即高亮目标（不等平滑滚动结束）；滚动落定后交还 scroll 联动。
  const [outlineJumpId, setOutlineJumpId] = useState<string | null>(null)
  const outlineJumpTimer = useRef<number | null>(null)
  const jumpToHeading = (id: string) => {
    setOutlineJumpId(id)
    if (outlineJumpTimer.current) window.clearTimeout(outlineJumpTimer.current)
    // 平滑滚动 260ms + 余量；超时后交还滚动联动（此时 tolerance 已让目标保持高亮）
    outlineJumpTimer.current = window.setTimeout(() => setOutlineJumpId(null), 500)
  }
  useEffect(() => () => {
    if (outlineJumpTimer.current) window.clearTimeout(outlineJumpTimer.current)
  }, [])
  const activeHeadingId = outlineJumpId ?? scrollActiveHeadingId
  const updatedAt = doc ? formatRelative(doc.updated_at, 'long') : ''
  const createdAt = doc ? formatRelative(doc.created_at, 'long') : ''
  const wordCount = doc ? countWords(doc) : 0
  const isEmpty = wordCount === 0
  // 阅读态文档区自定义右键菜单；为空文档 / 编辑态不下文阔（空文档只出猜不打是，复用
  // BlockRenderer 下的 data-block-id 查回 Block 做 md 序列化）
  const ctxMenu = useDocContextMenu({ rootBlock: doc, disabled: isEditing || isEmpty })

  // 首屏骨架：结构与正式布局一致（header + 内容列 + 右栏），加载完成后布局零跳动
  if (!doc && loading && showSkeleton) {
    return (
      <div className="flex flex-col lg:flex-row h-full animate-pulse">
        <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
          <div className="h-14 shrink-0 border-b border-border/50" />
          <div className="flex-1 overflow-hidden">
            <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-10 space-y-3">
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
        <div className="hidden lg:flex lg:flex-col w-[288px] shrink-0 bg-sidebar/30">
          <div className="h-14 shrink-0 border-b border-border/50" />
        </div>
      </div>
    )
  }

  // 加载中但还没到骨架延迟：空 div 撑住布局，避免 Error 态闪现
  if (!doc && loading) return <div className="flex-1" />

  if (!doc) return <ErrorState message={error || t('doc.docNotFound')} />

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col h-full border-r border-border/50">
        {/* Global Sticky Header — 左：上一篇/下一篇 ｜ 中：标题（居中） ｜ 右：操作 */}
        <PageHeader bare className="shrink-0 px-3 sm:px-6">
          {/* 左：顺序导航（Obsidian 式；按创建顺序，单篇两侧禁用） */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => neighbors.prev && navigate(`/doc/${neighbors.prev.id}`)}
              disabled={!neighbors.prev}
              title={neighbors.prev ? t('doc.prevDoc', { title: neighbors.prev.title }) : t('doc.noPrevDoc')}
              className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label={t('doc.prevDoc', { title: neighbors.prev?.title ?? '' })}
            >
              <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => neighbors.next && navigate(`/doc/${neighbors.next.id}`)}
              disabled={!neighbors.next}
              title={neighbors.next ? t('doc.nextDoc', { title: neighbors.next.title }) : t('doc.noNextDoc')}
              className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label={t('doc.nextDoc', { title: neighbors.next?.title ?? '' })}
            >
              <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
          {/* 中：文档标题（flex-1 撑满中间，居中截断） */}
          <div className="flex-1 min-w-0 flex justify-center">
            <span className="font-medium text-foreground truncate text-sm max-w-full">
              {doc.content || t('doc.untitledDocument')}
            </span>
          </div>
          {/* 右：操作按钮组 */}
          <div className="flex items-center gap-2">
            {!isEditing && (
              <button
                type="button"
                onClick={handleStartEdit}
                className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent"
                title={t('doc.enterEdit')}
              >
                <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            )}
            {isEditing && (
              <span
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
                title={t('doc.editSaveHint')}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                {t('doc.editing')}
              </span>
            )}
            {!isEditing && <DemoModeButton />}
            <div className="w-px h-4 bg-border/60 mx-1" />
            <Tooltip label={t('doc.exportDoc')}>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={exporting || loading}
                className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
              >
                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />}
              </button>
            </Tooltip>
            <Tooltip label={t('doc.viewGraph')}>
              <Link
                to={`/graph?mode=docs&center=${encodeURIComponent(id ?? '')}&center_type=doc`}
                className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <Network className="w-3.5 h-3.5" strokeWidth={1.75} />
              </Link>
            </Tooltip>
            <Tooltip label={docShared ? t('doc.alreadyShared') : t('doc.shareDoc')}>
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
            <Tooltip label={t('doc.deleteDoc')}>
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
            <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-14 pb-32 animate-fade-in">
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
                  {draftInfo.updatedAt > 0
                    ? t('doc.draftWarningWithTime', { time: relativeTime(new Date(draftInfo.updatedAt)) })
                    : t('doc.draftWarning')}
                </span>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  {t('doc.continueEdit')}
                </button>
                <button
                  type="button"
                  onClick={() => { editorDraft.clearDraft(); setDraftInfo(null) }}
                  className="text-muted-foreground/70 hover:text-destructive transition-colors"
                >
                  {t('doc.discard')}
                </button>
              </div>
            )}
            {docStatus === 'inbox' && (
              <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <Inbox className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 min-w-[12rem]">{t('doc.inboxDescription')}</span>
                <button
                  type="button"
                  onClick={handlePromoteFromInbox}
                  disabled={statusSaving}
                  className="shrink-0 text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  {t('doc.addToNotes')}
                </button>
                <Link to="/inbox" className="shrink-0 text-muted-foreground hover:text-foreground">
                  {t('doc.backToInbox')}
                </Link>
              </div>
            )}
            {docStatus === 'archived' && (
              <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
                <Archive className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 min-w-[12rem]">{t('doc.archivedDescription')}</span>
                <button
                  type="button"
                  onClick={handleToggleArchive}
                  disabled={statusSaving}
                  className="shrink-0 text-foreground underline underline-offset-2 hover:text-foreground/80"
                >
                  {t('doc.restoreToNotes')}
                </button>
                <Link to="/archived" className="shrink-0 text-muted-foreground hover:text-foreground">
                  {t('doc.viewArchived')}
                </Link>
              </div>
            )}
            {/* 阅读列：标题/meta/tags/正文 走 --reading-max-w；状态横幅保留在外层 max-w-4xl。
                demo-zoom：演示模式整体等比放大（仅阅读态；编辑态不缩放） */}
            <div className={`mx-auto max-w-[var(--reading-max-w)] ${demo.active && !isEditing ? 'demo-zoom' : ''}`}>
            {/* Title — always editable, AI-generate on hover */}
            <div className="group relative">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={handleTitleKeyDown}
                className="input-underline font-bold text-foreground"
                placeholder={t('doc.untitledDocument')}
              />
              {/* 未配置 Chat 时不展示：避免「可点但静默失败」；ai_exclude 仍显示禁用态 */}
              {(ai.chat || aiExclude) && (
              <button
                type="button"
                onClick={handleSuggestTitle}
                disabled={generatingTitle || aiExclude || !ai.chat}
                className="absolute right-1 sm:-right-8 top-3 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-50 p-1.5 text-muted-foreground hover:text-foreground transition-all rounded disabled:opacity-30"
                title={aiExclude ? t('doc.aiHiddenNoTitle') : t('doc.generateTitleAi')}
              >
                {generatingTitle ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" strokeWidth={1.75} />
                )}
              </button>
              )}
            </div>

            {/* Meta row — 阅读态展示，融入标题与正文之间 */}
            {!isEditing && (
              <div className="mt-2 mb-8 text-[12px] text-muted-foreground/70 tabular-nums select-none">
                {wordCount.toLocaleString(currentLocale())} {t('doc.charCount')}
                {createdAt && (
                  <>
                    <span className="mx-2 text-border-strong">·</span>
                    {t('doc.createdAtLabel', { time: createdAt })}
                  </>
                )}
                {updatedAt && (
                  <>
                    <span className="mx-2 text-border-strong">·</span>
                    {t('doc.updatedAtLabel', { time: updatedAt })}
                  </>
                )}
              </div>
            )}
            {/* 演示模式控制已移至右上角（仅阅读态） */}

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
                    title={t('doc.archiveTooltip')}
                  >
                    {t('doc.archive')}
                  </button>
                )}
                {!aiExclude && (
                  <button
                    type="button"
                    onClick={handleToggleAiExclude}
                    disabled={aiExcludeSaving}
                    className="text-[11.5px] text-muted-foreground/75 hover:text-foreground transition-colors"
                    title={t('doc.aiExcludeTooltip')}
                  >
                    {t('doc.aiExclude')}
                  </button>
                )}
              </div>
            </div>

            {aiExclude && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground/80 leading-relaxed">
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-foreground/80">
                  <EyeOff className="w-3 h-3 shrink-0" strokeWidth={1.75} />
                  {t('doc.aiExcluded')}
                </span>
                <span>{t('doc.aiExcludeDescription')}</span>
                <button
                  type="button"
                  onClick={handleToggleAiExclude}
                  disabled={aiExcludeSaving}
                  className="text-foreground/90 underline underline-offset-2 hover:text-foreground"
                >
                  {t('doc.restoreAiVisible')}
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
                onAutoSaved={reloadHistoryIfOpen}
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
                    <h3 className="text-[15px] font-medium text-foreground mb-1.5">{t('doc.emptyDocument')}</h3>
                    <p className="text-[13px] text-muted-foreground max-w-[300px] leading-relaxed flex items-center justify-center gap-1.5 flex-wrap">
                      <span>{t('doc.emptyDocumentHintStart')}</span>
                      <Kbd>⌘E</Kbd>
                      <span>{t('doc.emptyDocumentHintMid')}</span>
                      <Kbd>⌘J</Kbd>
                      <span>{t('doc.emptyDocumentHintEnd')}</span>
                    </p>
                  </div>
                )}

                {/* Mobile outline — 折叠目录置于正文前，方便快速导航 */}
                {!isEditing && flatHeadings.length > 0 && (
                  <div className="lg:hidden mb-6">
                    <button
                      type="button"
                      onClick={() => setTocOpen((v) => !v)}
                      className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${tocOpen ? '' : '-rotate-90'}`}
                        strokeWidth={2}
                      />
                      {t('doc.tableOfContents')}
                      <span className="text-[11px] text-muted-foreground/60 tabular-nums ml-0.5">
                        {flatHeadings.length}
                      </span>
                    </button>
                    {tocOpen && (
                      <div className="mt-2 pl-5">
                        <OutlineView headings={flatHeadings} loading={auxLoading} activeId={activeHeadingId} onJump={jumpToHeading} />
                      </div>
                    )}
                  </div>
                )}

                <article
                  onContextMenu={ctxMenu.onContextMenu}
                  onKeyDown={ctxMenu.onKeyDown}
                >
                  <BlockRenderer block={doc} />
                  {ctxMenu.menu}
                </article>
               </div>
             )}
           </div>
           </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar (Desktop only) — AI 聊天打开时让位（替换右栏，不额外压正文） */}
      {!aiChatOpen && (
        <div
          className={`hidden lg:flex flex-col shrink-0 bg-sidebar/30 h-full transition-[width] duration-200 ${
            railActuallyCollapsed ? 'w-9' : railWidth === 'wide' ? 'w-[400px]' : 'w-[288px]'
          }`}
        >
          {/* 顶栏：五 Tab 均分居中（中/英都不横滚）；折叠钮单独占位 */}
          <div className="h-14 shrink-0 border-b border-border/50 flex items-stretch px-1 gap-0.5">
            {!railActuallyCollapsed && (
              <div className="flex-1 min-w-0 grid grid-cols-5 items-stretch">
                {(
                  [
                    { id: 'outline' as const, label: t('doc.outline') },
                    { id: 'backlinks' as const, label: t('doc.backlinks') },
                    { id: 'entities' as const, label: t('doc.entities') },
                    { id: 'related' as const, label: t('doc.related') },
                    { id: 'history' as const, label: t('doc.history') },
                  ] as const
                ).map((tab) => {
                  const active = railTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      title={tab.label}
                      onClick={() => setRailTab(tab.id)}
                      className={`min-w-0 px-0.5 pb-2.5 pt-3 text-[11px] font-medium transition-colors border-b-2 -mb-px truncate text-center ${
                        active
                          ? 'text-primary border-primary'
                          : 'text-muted-foreground border-transparent hover:text-foreground'
                      }`}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>
            )}
            {!railActuallyCollapsed && (
              <button
                type="button"
                onClick={() => setRailWidth((v) => (v === 'wide' ? 'normal' : 'wide'))}
                title={railWidth === 'wide' ? t('doc.narrowRail') : t('doc.widenRail')}
                aria-label={railWidth === 'wide' ? t('doc.narrowRail') : t('doc.widenRail')}
                aria-pressed={railWidth === 'wide'}
                className="shrink-0 self-center inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {railWidth === 'wide' ? <Minimize2 className="w-3.5 h-3.5" strokeWidth={1.75} /> : <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
              </button>
            )}
            <button
              type="button"
              onClick={toggleRailCollapsed}
              title={railActuallyCollapsed ? t('doc.expandRail') : t('doc.collapseRail')}
              aria-label={railActuallyCollapsed ? t('doc.expandRail') : t('doc.collapseRail')}
              className={`shrink-0 self-center inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
                railActuallyCollapsed ? 'w-7 h-7 mx-auto' : 'w-7 h-7'
              }`}
            >
              {railActuallyCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5" strokeWidth={1.75} /> : <PanelRightClose className="w-3.5 h-3.5" strokeWidth={1.75} />}
            </button>
          </div>
          {!railActuallyCollapsed && (
          <div className="flex-1 overflow-y-auto px-3.5 py-4">
            {/* key=railTab：切 Tab 重新挂载触发 140ms 纯 opacity 淡入 */}
            <div key={railTab} className="animate-fade-soft">
            {railTab === 'outline' && (
              <OutlineView headings={flatHeadings} loading={auxLoading} activeId={activeHeadingId} onJump={jumpToHeading} />
            )}
            {railTab === 'backlinks' && (
              <BacklinksView backlinks={backlinks} loading={auxLoading} />
            )}
            {railTab === 'entities' && id && (
              <EntityPanel docId={id} variant="bare" />
            )}
            {railTab === 'related' && (
              <RelatedView
                items={relatedItems}
                loading={relatedLoading}
                error={relatedError}
              />
            )}
            {railTab === 'history' && (
              <HistoryView
                docId={id ?? ''}
                revisions={revisions}
                loading={revisionsLoading}
                onRestored={() => {
                  loadRevisions()
                  // 恢复可能改了标题/正文 → 触发文档重新加载
                  setRefreshKey((k) => k + 1)
                }}
              />
            )}
            </div>
          </div>
          )}
        </div>
      )}

       <ConfirmDialog
        open={showDelete}
        title={t('doc.confirmDeleteTitle')}
        message={t('doc.confirmDeleteDescription')}
        confirmLabel={t('common.delete')}
        busy={deleting}
        busyLabel={t('doc.deleting')}
        tone="destructive"
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
  headings, loading, activeId, onJump,
}: {
  headings: Array<HeadingNode & { depth: number }>;
  loading: boolean;
  activeId: string | null;
  /** 点击大纲项：立即高亮目标（可选；不传则纯滚动） */
  onJump?: (id: string) => void;
}) {
  const { t } = useTranslation()
  // 仅首次加载（无数据）时显示加载态；切换文档时保留旧大纲直至新数据到达，避免闪烁
  if (loading && headings.length === 0) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">{t('common.loading')}</div>
  }
  if (headings.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        {t('doc.noHeadings')}
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      {headings.map((h) => {
        const isActive = h.id === activeId
        return (
          <a
            key={h.id}
            href={`#${h.id}`}
            aria-current={isActive ? 'location' : undefined}
            onClick={(e) => {
              e.preventDefault()
              // heading id = block.id（见 BlockRenderer）；手动 rAF 平滑滚动，规避部分环境原生 smooth 失效
              const el = document.getElementById(h.id)
              if (el) scrollToElement(el)
              // 立即高亮目标，不等滚动动画结束（滚动落定后 tolerance 保持高亮）
              onJump?.(h.id)
              history.replaceState(null, '', `#${h.id}`)
            }}
            className={`px-1.5 -mx-1.5 py-1 text-[12px] rounded transition-colors truncate ${
              isActive
                ? 'text-primary font-medium bg-primary-soft'
                : 'text-muted-foreground/85 hover:text-foreground'
            }`}
            style={{ paddingLeft: `${(h.depth * 12) + 6}px` }}
            title={h.content}
          >
            {h.content}
          </a>
        )
      })}
    </div>
  )
}

function BacklinksView({ backlinks, loading }: { backlinks: Backlink[]; loading: boolean }) {
  const { t } = useTranslation()
  if (loading && backlinks.length === 0) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">{t('common.loading')}</div>
  }
  if (backlinks.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        {t('doc.noBacklinks')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {backlinks.map((bl) => (
        <Link
          key={bl.id}
          to={'/doc/' + bl.source_root_id + '#block-' + bl.source_id}
          className="group block px-2.5 py-2 -mx-1 rounded-lg hover:bg-accent transition-colors"
        >
          <div className="text-[11px] font-medium text-foreground/75 line-clamp-1 mb-0.5">
            {bl.source_doc_title ?? '—'}
          </div>
          <p className="text-[12.5px] text-muted-foreground group-hover:text-foreground line-clamp-2 leading-relaxed transition-colors">
            {bl.source_content}
          </p>
        </Link>
      ))}
    </div>
  )
}

interface RelatedDocItem {
  doc_id: string
  title: string
  snippet: string
  score: number
}

/** 语义邻居：数据由父组件打开文档时预取 */
function RelatedView({
  items,
  loading,
  error,
}: {
  items: RelatedDocItem[] | null
  loading: boolean
  error: string | null
}) {
  const { t } = useTranslation()

  if (loading && items === null) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">{t('common.loading')}</div>
  }
  if (error) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        {error}
      </div>
    )
  }
  if (!items || items.length === 0) {
    return (
      <div className="px-1 space-y-1.5">
        <p className="text-[12px] text-muted-foreground/60 leading-relaxed">{t('doc.noRelated')}</p>
        <p className="text-[11.5px] text-muted-foreground/50 leading-relaxed">{t('doc.noRelatedHint')}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item) => (
        <Link
          key={item.doc_id}
          to={'/doc/' + item.doc_id}
          className="group block px-2.5 py-2 -mx-1 rounded-lg hover:bg-accent transition-colors"
        >
          <div className="text-[11px] font-medium text-foreground/75 line-clamp-1 mb-0.5">
            {item.title || t('doc.untitledDocument')}
          </div>
          {item.snippet && (
            <p className="text-[12.5px] text-muted-foreground group-hover:text-foreground line-clamp-2 leading-relaxed transition-colors">
              {item.snippet}
            </p>
          )}
        </Link>
      ))}
    </div>
  )
}

/** 文档历史面板：跨块 revision 时间线（新→旧），支持预览与回退 */
function HistoryView({
  docId,
  revisions,
  loading,
  onRestored,
}: {
  docId: string
  revisions: DocRevision[]
  loading: boolean
  onRestored: () => void
}) {
  const toast = useToast()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [restoring, setRestoring] = useState<string | null>(null)

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleRestore = async (rev: DocRevision) => {
    const isSnapshot = rev.kind === 'snapshot'
    const ok = window.confirm(
      isSnapshot
        ? t('doc.confirmRevertSnapshot')
        : t('doc.confirmRevertBlock'),
    )
    if (!ok) return
    setRestoring(revisionKey(rev))
    try {
      if (isSnapshot) {
        // 整篇快照：走整篇替换端点（回退正文 + 标题，快照内容即完整 markdown）
        await api.post(`/docs/${docId}/snapshots/${rev.rev}/restore`, {})
      } else {
        await api.post(`/blocks/${rev.block_id}/revisions/${rev.rev}/restore`, {})
      }
      toast.success({ title: t('doc.reverted') })
      onRestored()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error({ title: t('doc.revertFailed'), description: msg })
    } finally {
      setRestoring(null)
    }
  }

  if (loading && revisions.length === 0) {
    return <div className="px-1 text-[12px] text-muted-foreground/70">{t('common.loading')}</div>
  }
  if (revisions.length === 0) {
    return (
      <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
        {t('doc.noHistory')}
      </div>
    )
  }

  const snapshots = revisions.filter((r) => r.kind === 'snapshot')
  const blockEdits = revisions.filter((r) => r.kind === 'block')

  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-[11px] text-muted-foreground/60 leading-relaxed">
        {t('doc.historyDescription')}
      </p>

      {/* 整篇快照：文档级时间线 */}
      {snapshots.length > 0 && (
        <section>
          <h4 className="px-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.05em] text-muted-foreground/50">
            {t('doc.snapshotSection')}
          </h4>
          <div className="flex flex-col gap-1">
            {snapshots.map((rev, idx) => {
              // 与该快照「更旧的下一条」做 diff，突出本次改了什么（最新一条无更旧对照 → null）
              const prev = snapshots[idx + 1]
              const diff = prev ? lineDiff(prev.content, rev.content) : null
              return (
                <RevisionItem
                  key={revisionKey(rev)}
                  rev={rev}
                  label={actorLabel(rev)}
                  diff={diff ? summarizeDiff(diff) : null}
                  expanded={expanded}
                  restoring={restoring}
                  onToggle={toggle}
                  onRestore={handleRestore}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* 块级修改：单块历史 */}
      {blockEdits.length > 0 && (
        <section>
          <h4 className="px-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.05em] text-muted-foreground/50">
            {t('doc.blockEditSection')}
          </h4>
          <div className="flex flex-col gap-1">
            {blockEdits.map((rev) => (
              <RevisionItem
                key={revisionKey(rev)}
                rev={rev}
                label={actorLabel(rev)}
                expanded={expanded}
                restoring={restoring}
                onToggle={toggle}
                onRestore={handleRestore}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function RevisionItem({
  rev,
  label,
  diff,
  expanded,
  restoring,
  onToggle,
  onRestore,
}: {
  rev: DocRevision
  label: string
  /** 整篇快照的变更 diff（相对更旧快照）；null = 无对照（最新）或非快照 */
  diff?: DiffLine[] | null
  expanded: ReadonlySet<string>
  restoring: string | null
  onToggle: (key: string) => void
  onRestore: (rev: DocRevision) => void
}) {
  const key = revisionKey(rev)
  const isOpen = expanded.has(key)
  const { t } = useTranslation()
  return (
    <div className="group rounded-lg border border-border/50 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block text-[11.5px] text-muted-foreground truncate">{label}</span>
          <span className="block text-[10.5px] text-muted-foreground/60 tabular-nums">
            {formatSqliteDateTime(rev.created_at)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
          title={isOpen ? t('doc.collapse') : t('doc.preview')}
        >
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        {!rev.is_current && (
          <button
            type="button"
            disabled={restoring === key}
            onClick={() => onRestore(rev)}
            className="shrink-0 px-1.5 py-1 text-[11px] font-medium text-primary/80 hover:text-primary disabled:opacity-50 transition-colors"
          >
            {restoring === key ? '…' : t('doc.revert')}
          </button>
        )}
      </div>
      {isOpen && (
        diff && diff.length > 0 ? (
          <div className="px-3 py-2 border-t border-border/40 text-[11px] leading-relaxed font-mono max-h-40 overflow-y-auto">
            {diff.map((l, i) => (
              <div
                key={i}
                className={l.type === 'added'
                  ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-1 -mx-1'
                  : l.type === 'removed'
                    ? 'text-rose-700 dark:text-rose-400 bg-rose-500/10 px-1 -mx-1'
                    : 'text-muted-foreground/60'}
              >
                {l.type === 'added' ? '+ ' : l.type === 'removed' ? '− ' : '  '}
                {l.text || '⏎'}
              </div>
            ))}
          </div>
        ) : (
          <pre className="px-3 py-2 border-t border-border/40 text-[11px] leading-relaxed whitespace-pre-wrap font-sans text-muted-foreground bg-background/40 max-h-40 overflow-y-auto">
            {rev.content || t('doc.emptyContent')}
          </pre>
        )
      )}
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  const { t } = useTranslation()
  return (
    <div className="card text-center py-16 px-6 animate-fade-in">
      <p className="text-destructive mb-4">{message}</p>
      <Link to="/" className="text-primary hover:underline text-sm inline-flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        {t('doc.backToHome')}
      </Link>
    </div>
  )
}
/** 演示模式按钮（右上角，仅阅读态）：平时一个小图标开关；激活后展开档位组（125/150/175/200%） */
function DemoModeButton() {
  const { t } = useTranslation()
  const demo = useDemoMode()
  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={t('doc.demoMode.label')}
      title={t('doc.demoMode.shortcutHint')}
    >
      <button
        type="button"
        onClick={() => {
          if (demo.active) resetDemoZoom()
          else cycleDemoZoom(0 as 1)
        }}
        aria-pressed={demo.active}
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
          demo.active
            ? 'text-primary bg-primary/12 hover:bg-primary/15'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        }`}
      >
        <Presentation className="w-3.5 h-3.5" strokeWidth={1.75} />
      </button>
      {demo.active && (
        <>
          {DEMO_ZOOMS.map((z, i) => {
            const active = demo.zoomIndex === i
            return (
              <button
                key={z}
                type="button"
                onClick={() => setDemoZoomIndex(i)}
                aria-pressed={active}
                className={`min-w-[32px] h-6 px-1 rounded text-[11px] font-mono tabular-nums transition-colors ${
                  active
                    ? 'bg-primary/12 text-foreground border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent'
                }`}
              >
                {Math.round(z * 100)}%
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}
