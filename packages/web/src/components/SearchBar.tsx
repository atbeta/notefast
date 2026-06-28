import { useState, useCallback } from 'react'
import type { SearchResult } from '@notefast/core'
import { Search } from 'lucide-react'

interface SearchBarProps {
  onSearch: (query: string) => Promise<SearchResult[]>
  onSelect: (blockId: string) => void
}

export default function SearchBar({ onSearch, onSelect }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSearch = useCallback(
    async (q: string) => {
      setQuery(q)
      if (q.trim().length < 2) {
        setResults([])
        setIsOpen(false)
        return
      }
      setLoading(true)
      try {
        const res = await onSearch(q)
        setResults(res)
        setIsOpen(res.length > 0)
      } finally {
        setLoading(false)
      }
    },
    [onSearch],
  )

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="搜索文档..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {isOpen && (
        <div className="absolute top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto z-20">
          {results.map((r) => (
            <button
              key={r.block.id}
              onClick={() => {
                onSelect(r.block.root_id)
                setIsOpen(false)
                setQuery('')
              }}
              className="block w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
            >
              <p className="text-xs text-gray-400 mb-0.5">{r.block.type}</p>
              <p className="text-sm text-gray-700 line-clamp-2">{r.snippet}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
