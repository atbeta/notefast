import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Trash2, FileText } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import DocList from '../components/DocList'
import SubNavTabs from '../components/SubNavTabs'
import TagFilter from '../components/TagFilter'

type TabKey = 'mine' | 'recent'

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('mine')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tagFilter = searchParams.get('tag') || ''

  const fetchDocs = useCallback(() => {
    setLoading(true)
    const q = tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : ''
    api
      .get<DocSummary[]>(`/docs/list${q}`)
      .then(setDocs)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [tagFilter])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const handleRefresh = useCallback(() => { fetchDocs() }, [fetchDocs])

  const goNew = useCallback(() => { navigate('/new') }, [navigate])

  const recentDocs = docs.filter((d) => {
    const ts = new Date(d.updated_at).getTime()
    return Number.isFinite(ts) && ts >= Date.now() - 24 * 60 * 60 * 1000
  })

  const visibleDocs = activeTab === 'recent' ? recentDocs : docs

  return (
    <div className="animate-fade-in">
      {/* 全局顶栏：h-14 + 底边框，与侧边栏顶栏贯通成一条水平基准线 */}
      <header className="sticky top-0 z-10 h-14 border-b border-border/50 bg-background">
        <div className="h-full w-full max-w-4xl mx-auto px-8">
          <SubNavTabs
            embedded
            activeKey={activeTab}
            onChange={(k) => setActiveTab(k as TabKey)}
            tabs={[
              { key: 'mine', label: '我的文档', badge: !loading ? <span className="font-mono text-[11px] text-muted-foreground/80">{docs.length}</span> : null },
              { key: 'recent', label: '最近编辑' },
            ]}
            trailing={
              <button onClick={goNew} className="btn-primary-custom">
                <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
                新建文档
              </button>
            }
          />
        </div>
      </header>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5 animate-fade-in">
        {/* 标签筛选 — chip 单选，点击切换 URL ?tag=xxx */}
        <TagFilter />

        <section key={activeTab} className="space-y-3 animate-fade-in">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {activeTab === 'recent' ? '最近 24 小时编辑' : '所有文档'}
            </h3>
            <span className="text-xs text-muted-foreground/70 font-mono">
              {loading ? '加载中…' : `${visibleDocs.length} 篇`}
            </span>
          </div>

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
          ) : visibleDocs.length === 0 ? (
            <EmptyState onCreate={goNew} tab={activeTab} />
          ) : (
            <DocList docs={visibleDocs} onRefresh={handleRefresh} />
          )}
        </section>
      </div>
    </div>
  )
}

function EmptyState({ onCreate, tab }: { onCreate: () => void; tab: TabKey }) {
  const isMineEmpty = tab === 'mine'
  return (
    <div className="px-3 py-12 flex flex-col items-center text-center">
      <div className="empty-icon-tile">
        {isMineEmpty ? <FileText className="w-5 h-5" /> : <Trash2 className="w-5 h-5" />}
      </div>
      <h3 className="text-[15px] font-medium text-foreground mb-1.5 tracking-[-0.005em]">
        {isMineEmpty ? '这里还没有文档' : '近 24 小时没有改动过'}
      </h3>
      <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
        {isMineEmpty
          ? '点一下下方按钮，新建你的第一篇 Markdown 文档。也可以把现有 .md 文件拖进编辑器直接导入。'
          : '回到「我的文档」查看全部内容，或新建一篇开启今天的记录。'}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card hover:border-foreground/30 hover:text-foreground text-foreground text-sm font-medium transition-colors"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
        新建文档
      </button>
      {isMineEmpty && (
        <p className="mt-4 text-[11.5px] text-muted-foreground/65 leading-relaxed">
          <kbd className="font-mono text-[10.5px] px-1 py-px border border-border rounded bg-background text-foreground/80">⌘N</kbd>
          {' '}随时调出
        </p>
      )}
    </div>
  )
}