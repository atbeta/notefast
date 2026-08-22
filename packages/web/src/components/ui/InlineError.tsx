import { AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

export interface InlineErrorProps {
  message: string
  title?: string
  onRetry?: () => void
  /** 已有内容时的顶栏提示，不用大空态 */
  compact?: boolean
}

export function InlineError({ message, title, onRetry, compact = false }: InlineErrorProps) {
  const { t } = useTranslation()
  const heading = title ?? t('common.error')
  const retry = onRetry ? (
    <Button type="button" variant={compact ? 'ghost' : 'secondary'} size="sm" onClick={onRetry} className={compact ? 'min-w-0 shrink-0' : undefined}>
      {t('common.retry')}
    </Button>
  ) : null

  if (compact) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-[12.5px]"
      >
        <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="text-foreground font-medium">{heading}</p>
          <p className="text-muted-foreground break-all leading-relaxed">{message}</p>
        </div>
        {retry}
      </div>
    )
  }

  return (
    <div role="alert">
      <EmptyState
        icon={<AlertCircle className="w-5 h-5" />}
        title={heading}
        description={<span className="break-all">{message}</span>}
        action={retry}
      />
    </div>
  )
}
