import { useState, useEffect } from 'react'
import { request } from '../hooks/useAPI'

interface Backlink {
  id: number
  source_id: string
  target_id: string
  source_content: string
  source_type: string
  ref_type: string
}

interface BacklinksProps {
  blockId: string
}

export default function Backlinks({ blockId }: BacklinksProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    request<Backlink[]>(`/search/refs?target_id=${blockId}`)
      .then(setBacklinks)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [blockId])

  if (loading) {
    return <div className="text-xs text-muted-foreground py-2">加载引用...</div>
  }

  if (backlinks.length === 0) {
    return <div className="text-xs text-muted-foreground py-2">暂无引用</div>
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">反向链接 ({backlinks.length})</h4>
      {backlinks.map((bl) => (
        <div key={bl.id} className="text-sm p-2 bg-secondary rounded border border-border hover:border-primary/30 transition-colors">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground bg-accent rounded px-1.5 py-0.5">{bl.source_type}</span>
            <span className="text-xs text-muted-foreground">{bl.ref_type}</span>
          </div>
          <p className="text-foreground line-clamp-2">{bl.source_content}</p>
        </div>
      ))}
    </div>
  )
}
