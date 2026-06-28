import type { DocSummary } from '@notefast/core'
import { Link } from 'react-router-dom'
import { FileText } from 'lucide-react'

interface DocListProps {
  docs: DocSummary[]
}

export default function DocList({ docs }: DocListProps) {
  if (docs.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>还没有文档</p>
        <p className="text-sm mt-1">通过 MCP 或 API 导入 Markdown 来创建第一个文档</p>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {docs.map((doc) => (
        <Link
          key={doc.id}
          to={`/doc/${doc.id}`}
          className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-start gap-3">
            <FileText className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <h3 className="font-medium text-gray-900 truncate">{doc.title || '未命名文档'}</h3>
              <p className="text-xs text-gray-400 mt-1">
                更新于 {new Date(doc.updated_at).toLocaleDateString('zh-CN')}
              </p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
