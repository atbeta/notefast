import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { Block, HeadingNode } from '@notefast/core'
import {
  ArrowLeft,
  Trash2,
  Pencil,
  Check,
  X,
  ListTree,
  Link2,
  Edit3,
  FileText,
} from 'lucide-react'
import { api, request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import MarkdownEditor from '../components/MarkdownEditor'
import ConfirmDialog from '../components/ConfirmDialog'
import SubNavTabs from '../components/SubNavTabs'

type ViewTab = 'content' | 'outline' | 'refs'

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
  const [activeTab, setActiveTab] = useState<ViewTab>('content')

  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const [forceEditKey, setForceEditKey] = useState(0)

  const [headings, setHeadings] = useState<HeadingNode[]>([])
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [auxLoading, setAuxLoading] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    api.get<Block>('/docs/' + id).then(setDoc).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [id, refreshKey])

  // 新建文档后自动进入编辑模式
  useEffect(() => {
    if (searchParams.get('edit') === '1' && doc && activeTab !== 'content') {
      setActiveTab('content')
    }
  }, [searchParams, doc, activeTab])

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

  const startTitleEdit = () => {
    if (!doc) return
    setTitleDraft(doc.content)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  const saveTitle = async () => {
    if (!id || !doc || !titleDraft.trim()) return
    try {
      await api.patch('/blocks/' + id, { content: titleDraft.trim() })
      setEditingTitle(false)
      setRefreshKey((k) => k + 1)
    } catch { /* keep editing on error */ }
  }

  const cancelTitleEdit = () => { setEditingTitle(false) }
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
        <div className="h-9 bg-secondary rounded w-1/2" />
        <div className="card p-6 space-y-3">
          <div className="h-4 bg-secondary rounded w-full" />
          <div className="h-4 bg-secondary rounded w-5/6" />
          <div className="h-4 bg-secondary rounded w-4/6" />
        </div>
      </div>
    )
  }

  if (error) return <ErrorState message={error} />
  if (!doc) return <ErrorState message="文档不存在" />

  const flatHeadings = flattenHeadings(headings)
  const updatedAt = formatTime(doc.updated_at)
  const createdAt = formatTime(doc.created_at)
  const wordCount = countWords(doc)
  const isEmpty = wordCount === 0

  return (
    <div className="animate-fade-in space-y-6">
      <SubNavTabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as ViewTab)}
        tabs={[
          { key: 'content', label: '内容' },
          { key: 'outline', label: '目录', badge: headings.length > 0 ? <span className="font-mono text-[11px] text-muted-foreground/80">({headings.length})</span> : null },
          { key: 'refs', label: '反向链接', badge: backlinks.length > 0 ? <span className="font-mono text-[11px] text-muted-foreground/80">({backlinks.length})</span> : null },
        ]}
        trailing={
          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>返回</span>
            </Link>
            <span className="w-px h-4 bg-border" />
            {id && (
              <MarkdownEditor
                key={`editor-${id}-${forceEditKey}`}
                docId={id}
                onSaved={handleEditSaved}
                autoEdit={searchParams.get('edit') === '1' || forceEditKey > 0}
              />
            )}
            <button
              onClick={() => setShowDelete(true)}
              className="btn-icon-ghost"
              title="删除文档"
              aria-label="删除文档"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        }
      />

      <div className="card">
        <div className="flex items-start gap-3.5 px-5 py-4">
          <button
            type="button"
            onClick={() => setActiveTab('content')}
            className="hero-orb hero-orb-sm shrink-0 mt-0.5"
            aria-label="返回正文"
            title="返回正文"
          >
            <Edit3 />
          </button>
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  className="input-underline"
                />
                <button onClick={saveTitle} className="btn-icon-ghost" title="保存" style={{ color: 'rgb(var(--primary))' }}>
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={cancelTitleEdit} className="btn-icon-ghost" title="取消">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-2 group">
                <h1 className="text-[17px] font-semibold text-foreground leading-tight tracking-[-0.022em] truncate" title={doc.content}>
                  {doc.content}
                </h1>
                <button
                  onClick={startTitleEdit}
                  className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-primary hover:bg-accent rounded transition-all shrink-0"
                  title="编辑标题"
                  aria-label="编辑标题"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="meta-mono">
              <span>更新于 {updatedAt || '—'}</span>
              <span>创建于 {createdAt || '—'}</span>
              <span>{wordCount.toLocaleString('zh-CN')} 字</span>
            </div>

            <div className={'warn-hint ' + (isEmpty ? 'show' : '')}>
              文档正文为空 —{' '}
              <button
                onClick={() => setForceEditKey((k) => k + 1)}
                className="underline underline-offset-2 font-medium hover:text-warn transition-colors"
              >
                点此开始写作
              </button>
            </div>
          </div>
        </div>
      </div>

      <div key={activeTab} className="animate-fade-in">
        {activeTab === 'content' && (
          <article className="card p-7 prose dark:prose-invert max-w-none">
            <BlockRenderer block={doc} />
          </article>
        )}

        {activeTab === 'outline' && (
          <OutlineView headings={flatHeadings} loading={auxLoading} onJump={() => setActiveTab('content')} />
        )}

        {activeTab === 'refs' && (
          <BacklinksView backlinks={backlinks} loading={auxLoading} />
        )}
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
  headings, loading, onJump,
}: { headings: Array<HeadingNode & { depth: number }>; loading: boolean; onJump: () => void }) {
  if (loading) {
    return <div className="card p-6 text-sm text-muted-foreground">加载目录...</div>
  }
  if (headings.length === 0) {
    return (
      <div className="card py-12 px-6 text-center">
        <div className="empty-icon-tile">
          <ListTree className="w-5 h-5" />
        </div>
        <h3 className="text-base font-semibold text-foreground mb-2">暂无目录</h3>
        <p className="text-[13px] text-muted-foreground mb-5 max-w-sm mx-auto leading-relaxed">
          用 #、## 添加标题后会自动生成
        </p>
        <button onClick={onJump} className="text-sm text-primary hover:underline font-medium">
          返回正文 →
        </button>
      </div>
    )
  }
  return (
    <div className="card overflow-hidden">
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          onClick={() => onJump()}
          className="outline-row"
          data-depth={h.depth + 1}
        >
          <span className="outline-level">H{h.depth + 1}</span>
          <span className="truncate">{h.content}</span>
        </a>
      ))}
    </div>
  )
}

function BacklinksView({ backlinks, loading }: { backlinks: Backlink[]; loading: boolean }) {
  if (loading) {
    return <div className="card p-6 text-sm text-muted-foreground">加载反向链接...</div>
  }
  if (backlinks.length === 0) {
    return (
      <div className="card py-12 px-6 text-center">
        <div className="empty-icon-tile">
          <Link2 className="w-5 h-5" />
        </div>
        <h3 className="text-base font-semibold text-foreground mb-2">尚无反向链接</h3>
        <p className="text-[13px] text-muted-foreground mb-5 max-w-sm mx-auto leading-relaxed">
          使用 [[wiki 链接]] 或 [[块 ID]] 引用此文档时，引用方会出现在这里
        </p>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="w-3 h-3" /> 0 个引用
        </span>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {backlinks.map((bl) => (
        <Link
          key={bl.id}
          to={'/doc/' + bl.source_id}
          className="card-interactive block p-4"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="ref-type-pill">{bl.source_type}</span>
            <span className="ref-label">{bl.ref_type}</span>
          </div>
          <p className="text-[13px] text-foreground line-clamp-2 leading-relaxed">{bl.source_content}</p>
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