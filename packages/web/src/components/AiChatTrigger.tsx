import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAiChatCtl } from './Layout'
import { Tooltip } from './ui'

/**
 * 桌面端内容顶栏 AI 常驻入口（md+）。
 * 移动端已有 Layout 顶栏 Sparkles，此处隐藏以免双入口。
 */
export default function AiChatTrigger({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const { open, toggle } = useAiChatCtl()

  return (
    <Tooltip label={t('layout.openAiChat')}>
      <button
        type="button"
        onClick={toggle}
        className={`hidden md:inline-flex btn-icon-ghost shrink-0 transition-colors ${
          open
            ? 'text-primary bg-primary-soft hover:bg-primary-soft'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        } ${className}`.trim()}
        aria-label={t('layout.openAiChat')}
        aria-pressed={open}
      >
        <Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />
      </button>
    </Tooltip>
  )
}
