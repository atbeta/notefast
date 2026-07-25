import { FilePlus2, Loader2 } from 'lucide-react'

interface EditorFooterProps {
  charCount: number
  lines: number
  readMin: number
  dirty: boolean
  draftedAt: Date | null
  hasDraft: boolean
  onClearDraft: () => void
  onAppendFile?: (text: string) => void
  relativeTime: (date: Date | null) => string
}

export default function EditorFooter({
  charCount,
  lines,
  readMin,
  dirty,
  draftedAt,
  hasDraft,
  onClearDraft,
  onAppendFile,
  relativeTime,
}: EditorFooterProps) {
  return (
    <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground/70 tabular-nums">
      <span>
        {charCount.toLocaleString('zh-CN')} 字 · {lines.toLocaleString('zh-CN')} 行 · 约 {readMin} 分钟
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${dirty ? 'bg-amber-500' : 'bg-border'}`}
        />
        {dirty
          ? draftedAt
            ? `未保存 · 草稿 ${relativeTime(draftedAt)}`
            : '未保存'
          : '未修改'}
      </span>

      <span className="ml-auto flex items-center gap-1">
        {hasDraft && (
          <button
            type="button"
            onClick={onClearDraft}
            title="丢弃本地草稿并重新加载"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-muted-foreground/80 hover:text-destructive transition-colors"
          >
            <Loader2 className="w-3 h-3" strokeWidth={1.75} />
            丢弃草稿
          </button>
        )}
        {onAppendFile && (
          <button
            type="button"
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.md,.markdown,.txt'
              input.onchange = async () => {
                const file = input.files?.[0]
                if (!file) return
                const text = await file.text()
                onAppendFile('\n\n' + text + '\n\n')
              }
              input.click()
            }}
            title="追加本地 Markdown 文件 (.md)"
            aria-label="追加本地 Markdown 文件"
            className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground/80 hover:text-foreground hover:bg-accent transition-colors"
          >
            <FilePlus2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        )}
      </span>
    </div>
  )
}
