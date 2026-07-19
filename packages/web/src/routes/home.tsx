import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, FileText } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import DocList from '../components/DocList'
import SubNavTabs from '../components/SubNavTabs'

type TabKey = 'mine' | 'recent'

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('mine')
  const navigate = useNavigate()

  const fetchDocs = useCallback(() => {
    setLoading(true)
    api.get<DocSummary[]>('/docs/list').then(setDocs).catch(console.error).finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const handleRefresh = useCallback(() => { fetchDocs() }, [fetchDocs])

  const goNew = useCallback(() => { navigate('/new') }, [navigate])

  const recentDocs = docs.filter((d) => {
    const ts = new Date(d.updated_at).getTime()
    return Number.isFinite(ts) && ts >= Date.now() - 24 * 60 * 60 * 1000
  })

  const visibleDocs = activeTab === 'recent' ? recentDocs : docs

  return (
    <div className="animate-fade-in space-y-6">
      <SubNavTabs
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

      <div key={activeTab} className="space-y-5 animate-fade-in">
        {/* 简洁的入口行：不再用 giant hero 卡片 */}
        <div className="flex items-center gap-4 px-1">
          <button
            type="button"
            onClick={goNew}
            aria-label="新建文档"
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium border border-border bg-card hover:border-foreground/30 hover:text-foreground text-foreground transition-colors"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
            {activeTab === 'recent' ? '记录今日的想法' : '新建文档'}
          </button>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {activeTab === 'recent'
              ? '过去 24 小时内的所有改动 · ⌘N 新建一篇'
              : '把第一个想法写成 Markdown，⌘N 快速创建，或拖入 .md 文件直接导入。'}
          </p>
        </div>

        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {activeTab === 'recent' ? '最近编辑' : '所有文档'}
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