import type { DocSummary } from '@notefast/core'
import { Link } from 'react-router-dom'
import { FileText } from 'lucide-react'

interface DocListProps { docs: DocSummary[] }

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return diffMin + ' 分钟前'
  if (diffHr < 24) return diffHr + ' 小时前'
  if (diffDay < 7) return diffDay + ' 天前'
  return date.toLocaleDateString('zh-CN')
}

export default function DocList({ docs }: DocListProps) {
  return (
    <div className="grid gap-2">
      {docs.map((doc) => (
        <Link key={doc.id} to={'/doc/' + doc.id} className="card-interactive p-4 group">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm text-foreground truncate">{doc.title || '未命名文档'}</h3>
              <p className="text-xs text-muted-foreground mt-1">更新于 {formatRelative(doc.updated_at)}</p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
