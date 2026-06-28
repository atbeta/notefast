import { useState, useEffect, useCallback } from 'react'
import type { DocSummary, SearchResult } from '@notefast/core'
import { request } from '../hooks/useAPI'
import DocList from '../components/DocList'
import SearchBar from '../components/SearchBar'

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    request<DocSummary[]>('/docs/list').then(setDocs).catch(console.error).finally(() => setLoading(false))
  }, [])

  const handleSearch = useCallback(async (query: string): Promise<SearchResult[]> => {
    const params = new URLSearchParams({ q: query, limit: '10' })
    return request<SearchResult[]>(`/search?${params}`)
  }, [])

  const handleSelectResult = useCallback((docId: string) => {
    window.location.href = `/doc/${docId}`
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">文档</h1>
      </div>

      <SearchBar onSearch={handleSearch} onSelect={handleSelectResult} />

      {loading ? (
        <div className="text-center py-16 text-gray-400">加载中...</div>
      ) : (
        <DocList docs={docs} />
      )}
    </div>
  )
}
