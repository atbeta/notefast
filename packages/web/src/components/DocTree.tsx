import { useState, useEffect } from 'react'
import { request } from '../hooks/useAPI'
import type { HeadingNode } from '@notefast/core'

interface DocTreeProps {
  docId: string
}

export default function DocTree({ docId }: DocTreeProps) {
  const [headings, setHeadings] = useState<HeadingNode[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    request<HeadingNode[]>(`/docs/tree?doc_id=${docId}`)
      .then(setHeadings)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [docId])

  if (loading) return <div className="text-xs text-muted-foreground py-2">加载目录...</div>
  if (headings.length === 0) return null

  return (
    <nav className="space-y-0.5">
      <h4 className="text-sm font-medium text-foreground mb-2">目录</h4>
      {headings.map((h) => (
        <HeadingItem key={h.id} heading={h} depth={0} />
      ))}
    </nav>
  )
}

function HeadingItem({ heading, depth }: { heading: HeadingNode; depth: number }) {
  return (
    <div>
      <a
        href={`#${heading.id}`}
        className="block text-sm text-muted-foreground hover:text-primary py-1 transition-colors truncate"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {heading.content}
      </a>
      {heading.children.map((h) => (
        <HeadingItem key={h.id} heading={h} depth={depth + 1} />
      ))}
    </div>
  )
}
