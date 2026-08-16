import { ChatMarkdown } from '@notefast/shared'

interface PreviewPaneProps {
  content: string
}

/** 预览窗格：用 shared 的 ChatMarkdown 以阅读排版（reading-prose）渲染当前 Markdown。 */
export default function PreviewPane({ content }: PreviewPaneProps) {
  if (!content.trim()) {
    return <p className="text-sm text-muted-foreground">（空文档，无内容可预览）</p>
  }
  return (
    <div className="reading-prose max-w-[46rem]">
      <ChatMarkdown content={content} proseClass="reading-prose" />
    </div>
  )
}
