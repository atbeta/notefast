import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { DocSummary } from '@notefast/core'
import { FileText, Plus } from 'lucide-react'
import { request } from '../hooks/useAPI'
import DocList from '../components/DocList'

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    request<DocSummary[]>('/docs/list').then(setDocs).catch(console.error).finally(() => setLoading(false))
  }, [])

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">文档</h1>
          <p className="text-sm text-muted-foreground mt-1">{loading ? '加载中...' : docs.length + ' 篇文档'}</p>
        </div>
        <Link
          to="/new"
          className="flex items-center gap-1.5 px-3 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          新建文档
        </Link>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map((i) => (
            <div key={i} className="card animate-pulse p-5">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-secondary shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-5 bg-secondary rounded w-1/3" />
                  <div className="h-3.5 bg-secondary rounded w-1/4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center mb-6">
            <FileText className="w-10 h-10 text-muted-foreground/70" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">开始写作</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">创建新文档或通过 MCP、API 导入 Markdown</p>
          <Link
            to="/new"
            className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            创建第一篇文档
          </Link>
        </div>
      ) : (
        <DocList docs={docs} />
      )}
    </div>
  )
}
