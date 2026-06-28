import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { Block } from '@notefast/core'
import { ArrowLeft } from 'lucide-react'
import { request } from '../hooks/useAPI'
import BlockRenderer from '../components/BlockRenderer'
import SearchBar from '../components/SearchBar'
import type { SearchResult } from '@notefast/core'

export default function DocPage() {
  const { id } = useParams<{ id: string }>()
  const [doc, setDoc] = useState<Block | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    request<Block>(`/docs/${id}`)
      .then(setDoc)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  const handleSearch = useCallback(async (query: string): Promise<SearchResult[]> => {
    const params = new URLSearchParams({ q: query, limit: '10' })
    return request<SearchResult[]>(`/search?${params}`)
  }, [])

  const handleSelectResult = useCallback((docId: string) => {
    window.location.href = `/doc/${docId}`
  }, [])

  if (loading) {
    return <div className="text-center py-16 text-gray-400">加载中...</div>
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-red-500 mb-4">{error}</p>
        <Link to="/" className="text-blue-600 hover:underline">返回首页</Link>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-400 mb-4">文档不存在</p>
        <Link to="/" className="text-blue-600 hover:underline">返回首页</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          返回
        </Link>
        <div className="w-64">
          <SearchBar onSearch={handleSearch} onSelect={handleSelectResult} />
        </div>
      </div>

      <BlockRenderer block={doc} />
    </div>
  )
}
