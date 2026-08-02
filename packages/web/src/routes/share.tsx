import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileWarning, Globe } from 'lucide-react'
import ChatMarkdown from '../components/ChatMarkdown'
import { currentLocale } from '../lib/time'

/**
 * 公开分享阅读页（/s/:token）—— 无鉴权、无侧栏、无登录弹框。
 *
 * 数据走无鉴权公开端点 GET /share/:token（不走 api 客户端，避免注入
 * Authorization 与 401 跳登录逻辑）；无效/已关闭链接展示统一 404 页。
 * 正文中的 asset:<sha256> 引用重写为公开图片端点路径。
 */

interface SharedDoc {
  title: string
  markdown: string
  updated_at: string
  shared_at: string
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'notfound' }
  | { kind: 'loaded'; doc: SharedDoc }

/** blocksToMarkdown 在根写入 `# {title}`，页面已单独展示标题，去掉首行重复 H1 */
function stripLeadingTitleHeading(markdown: string, title: string): string {
  const firstLineEnd = markdown.indexOf('\n')
  const firstLine = firstLineEnd === -1 ? markdown : markdown.slice(0, firstLineEnd)
  if (firstLine.replace(/^#\s+/, '').trim() === title.trim() && firstLine.startsWith('# ')) {
    return markdown.slice(firstLineEnd + 1).replace(/^\s*\n/, '')
  }
  return markdown
}

export default function SharePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [state, setState] = useState<PageState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    fetch(`/share/${token}`)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ kind: 'notfound' })
          return
        }
        const doc = (await res.json()) as SharedDoc
        setState({ kind: 'loaded', doc })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'notfound' })
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (state.kind === 'loading') {
    return <div className="min-h-screen bg-background" />
  }

  if (state.kind === 'notfound') {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center px-6">
        <FileWarning className="w-8 h-8 text-muted-foreground/60 mb-4" strokeWidth={1.5} />
        <h1 className="text-[17px] font-medium text-foreground mb-1.5">{t('share.notFoundTitle')}</h1>
        <p className="text-[13.5px] text-muted-foreground">{t('share.notFoundDesc')}</p>
      </div>
    )
  }

  const { doc } = state
  const markdown = stripLeadingTitleHeading(doc.markdown, doc.title)
    .replace(/asset:([0-9a-f]{64})/g, `/share/${token}/assets/$1`)
  const updatedAt = new Date(doc.updated_at.replace(' ', 'T') + 'Z')
  const dateText = Number.isFinite(updatedAt.getTime())
    ? updatedAt.toLocaleDateString(currentLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
    : ''

  return (
    <div className="min-h-screen bg-background">
      {/* 公开可见提示：页面与登录后阅读页样式一致，需让访问者明确知道这是无需登录的公开分享页 */}
      <div className="border-b border-border/60 bg-muted/40">
        <div className="max-w-[var(--reading-max-w,42rem)] mx-auto px-6 py-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Globe className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
          {t('share.publicBanner')}
        </div>
      </div>
      <article className="max-w-[var(--reading-max-w,42rem)] mx-auto px-6 pt-12 pb-24">
        <header className="mb-8">
          <h1 className="text-[28px] font-bold text-foreground leading-snug tracking-[-0.01em]">
            {doc.title || t('share.untitled')}
          </h1>
          {dateText && (
            <p className="mt-2 text-[12.5px] text-muted-foreground/80">{t('share.updatedAt', { time: dateText })}</p>
          )}
        </header>
        <ChatMarkdown content={markdown} />
        <footer className="mt-16 pt-6 border-t border-border/60 text-center">
          <span className="text-[12px] text-muted-foreground/70">{t('share.byNoteFast')}</span>
        </footer>
      </article>
    </div>
  )
}
