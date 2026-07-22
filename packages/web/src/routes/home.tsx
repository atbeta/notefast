import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, FileText, Clock, Tag } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import DocList from '../components/DocList'
import TagFilter from '../components/TagFilter'

function viewTitle(params: URLSearchParams): string {
  if (params.get('untagged') === '1' || params.get('view') === 'untagged') return '未打标'
  const within = params.get('within') || params.get('updated_within') || ''
  if (params.get('view') === 'recent' || within) {
    if (within === '7d') return '最近 7 天'
    return '最近 24 小时'
  }
  const tags = params.get('tags') || params.get('tag')
  if (tags) return `标签：${tags}`
  return '所有文档'
}

function buildListQuery(params: URLSearchParams): string {
  const q = new URLSearchParams()
  const tags = params.get('tags') || ''
  const tag = params.get('tag') || ''
  if (tags) q.set('tags', tags)
  else if (tag) q.set('tag', tag)

  if (params.get('untagged') === '1' || params.get('view') === 'untagged') {
    q.set('untagged', '1')
    q.delete('tags')
    q.delete('tag')
  }

  const within = params.get('within') || params.get('updated_within') || ''
  if (within === '24h' || within === '7d') q.set('updated_within', within)
  else if (params.get('view') === 'recent') q.set('updated_within', '24h')

  const s = q.toString()
  return s ? `?${s}` : ''
}

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const listQuery = useMemo(() => buildListQuery(searchParams), [searchParams])
  const title = useMemo(() => viewTitle(searchParams), [searchParams])

  const fetchDocs = useCallback(() => {
    setLoading(true)
    api
      .get<DocSummary[]>(`/docs/list${listQuery}`)
      .then(setDocs)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [listQuery])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const handleRefresh = useCallback(() => { fetchDocs() }, [fetchDocs])
  const goNew = useCallback(() => { navigate('/new') }, [navigate])

  return (
    <div className="animate-fade-in">
      <header className="sticky top-0 z-10 h-14 border-b border-border/50 bg-background">
        <div className="h-full w-full max-w-4xl mx-auto px-8 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-2">
            <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
              {title}
            </h1>
            {!loading && (
              <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
                {docs.length}
              </span>
            )}
          </div>
          <button onClick={goNew} className="btn-primary-custom shrink-0">
            <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
            新建文档
          </button>
        </div>
      </header>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5 animate-fade-in">
        <TagFilter />

        <section className="space-y-3 animate-fade-in">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="card animate-pulse p-3.5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-secondary shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 bg-secondary rounded w-1/3" />
                      <div className="h-3 bg-secondary rounded w-1/4" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <EmptyState onCreate={goNew} title={title} />
          ) : (
            <DocList docs={docs} onRefresh={handleRefresh} />
          )}
        </section>
      </div>
    </div>
  )
}

function EmptyState({ onCreate, title }: { onCreate: () => void; title: string }) {
  const isAll = title === '所有文档'
  return (
    <div className="px-3 py-12 flex flex-col items-center text-center">
      <div className="empty-icon-tile">
        {isAll ? <FileText className="w-5 h-5" /> : title.includes('标签') || title === '未打标' ? <Tag className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
      </div>
      <h3 className="text-[15px] font-medium text-foreground mb-1.5 tracking-[-0.005em]">
        {isAll ? '这里还没有文档' : `「${title}」暂无文档`}
      </h3>
      <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
        {isAll
          ? '点一下下方按钮，新建你的第一篇 Markdown 文档。也可以把现有 .md 文件拖进编辑器直接导入。'
          : '试试切换其他智能视图，或新建一篇文档。'}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card hover:border-foreground/30 hover:text-foreground text-foreground text-sm font-medium transition-colors"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
        新建文档
      </button>
    </div>
  )
}
