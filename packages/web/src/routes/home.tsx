import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Sparkles, Calendar, Trash2, FileText } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import DocList from '../components/DocList'
import SubNavTabs from '../components/SubNavTabs'
import HeroAction from '../components/HeroAction'

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

  const heroTitle = activeTab === 'recent' ? '记录今日的想法' : '新建一篇文档'
  const heroSubtitle = activeTab === 'recent'
    ? '用 ⌘N 快速开始一个新文档'
    : '用 ⌘N 快速创建，或拖入 Markdown 文件直接导入'

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

      <div key={activeTab} className="space-y-6 animate-fade-in">
        <div className="card overflow-hidden">
          <div className="relative px-6 py-6">
            <HeroAction
              icon={activeTab === 'recent' ? Calendar : Plus}
              onPrimary={goNew}
              title={heroTitle}
              subtitle={heroSubtitle}
              ariaLabel="新建文档"
              chip={{
                icon: activeTab === 'recent' ? Calendar : Sparkles,
                label: activeTab === 'recent' ? '过去 24 小时' : '支持 Markdown · ⌘N',
              }}
            />
          </div>
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
  return (
    <div className="card py-12 px-6 text-center">
      <div className="empty-icon-tile">
        {tab === 'recent' ? <Trash2 className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
      </div>
      <h3 className="text-base font-semibold text-foreground mb-2">
        {tab === 'recent' ? '近 24 小时没有编辑过任何文档' : '开始你的第一篇文档'}
      </h3>
      <p className="text-[13px] text-muted-foreground mb-5 max-w-sm mx-auto leading-relaxed">
        {tab === 'recent'
          ? '回到「我的文档」查看全部内容，或新建一篇开启今天的记录。'
          : '创建新文档或通过 MCP、API 导入 Markdown，AI 也能直接帮你写入。'}
      </p>
      <button onClick={onCreate} className="btn-primary-custom">
        <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
        新建文档
      </button>
    </div>
  )
}