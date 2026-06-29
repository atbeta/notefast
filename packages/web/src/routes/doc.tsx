import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { Block } from '@notefast/core'
import { ArrowLeft } from 'lucide-react'
import { request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import DocTree from '../components/DocTree'
import Backlinks from '../components/Backlinks'
import MarkdownEditor from '../components/MarkdownEditor'

export default function DocPage() {
  const { id } = useParams<{ id: string }>()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    request<Block>('/docs/' + id).then(setDoc).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [id, refreshKey])

  const handleEditSaved = useCallback(() => { setRefreshKey((k) => k + 1) }, [])

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-warm-100 dark:bg-warm-700 rounded-lg w-2/3" />
        <div className="h-4 bg-warm-100 dark:bg-warm-700 rounded w-full" />
        <div className="h-4 bg-warm-100 dark:bg-warm-700 rounded w-5/6" />
        <div className="h-4 bg-warm-100 dark:bg-warm-700 rounded w-4/6" />
      </div>
    )
  }
  if (error) return <div className="text-center py-24"><p className="text-red-500 mb-4">{error}</p><Link to="/" className="text-brand-600 hover:underline text-sm">返回首页</Link></div>
  if (!doc) return <div className="text-center py-24"><p className="text-warm-400 mb-4">文档不存在</p><Link to="/" className="text-brand-600 hover:underline text-sm">返回首页</Link></div>

  return (
    <div className="animate-fade-in flex gap-8">
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-1.5 text-sm text-warm-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
            <ArrowLeft className="w-4 h-4" />返回
          </Link>
          <div className="flex items-center gap-3">{id && <MarkdownEditor docId={id} onSaved={handleEditSaved} />}</div>
        </div>
        <article className="prose dark:prose-invert max-w-none">
          <BlockRenderer block={doc} />
        </article>
      </div>
      <aside className="hidden lg:block w-56 shrink-0 space-y-6">
        <div className="sticky top-8">
          {id && <DocTree key={'tree-' + refreshKey} docId={id} />}
          <div className="mt-6">{id && <Backlinks key={'bl-' + refreshKey} blockId={id} />}</div>
        </div>
      </aside>
    </div>
  )
}