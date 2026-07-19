/**
 * ToastBanner — Toast 的 inline 对偶品
 *
 * 与 Toast 共享设计语言（圆形 icon box、左侧色带、标题/描述/关闭）
 * 但不放进右下角 stack，而是就地展示；适用于「保存后右侧出现 '已保存' 横条」
 *
 * 使用：
 *   <ToastBanner variant="success" title="已保存" description="Chat @ openai" onClose={() => set(null)} />
 *   <ToastBanner variant="error" title="保存失败" description={...}>
 *     <button onClick={retry}>重试</button>
 *   </ToastBanner>
 */

import type { ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'

export type BannerVariant = 'success' | 'error' | 'info' | 'warning'

export interface ToastBannerProps {
  variant: BannerVariant
  title: ReactNode
  description?: ReactNode
  onClose?: () => void
  /** 右侧操作按钮 / 自定义内容，会替换 close 按钮位置之前 */
  actions?: ReactNode
  className?: string
}

export function ToastBanner({ variant, title, description, onClose, actions, className = '' }: ToastBannerProps) {
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      data-variant={variant}
      className={`relative overflow-hidden rounded-[10px] bg-card text-card-foreground border border-border/70 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.1)] animate-fade-in ${className}`}
    >
      <div aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${BAR[variant]}`} />
      <div className="pl-4 pr-2 py-2.5 flex items-start gap-3">
        <div className={`shrink-0 w-6 h-6 mt-0.5 rounded-full grid place-items-center ${BOX[variant]}`}>
          {variant === 'success' ? (
            <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.25} />
          ) : variant === 'error' ? (
            <AlertCircle className="w-3.5 h-3.5" strokeWidth={2.25} />
          ) : variant === 'info' ? (
            <Info className="w-3.5 h-3.5" strokeWidth={2.25} />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2.25} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-medium leading-snug">{title}</div>
          {description && (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground leading-snug break-words">
              {description}
            </div>
          )}
          {actions && <div className="mt-1.5 flex items-center gap-2">{actions}</div>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 -mr-1 -mt-1 p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

const BAR: Record<BannerVariant, string> = {
  success: 'bg-emerald-500',
  error: 'bg-destructive',
  info: 'bg-sky-500',
  warning: 'bg-amber-500',
}

const BOX: Record<BannerVariant, string> = {
  success: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  error: 'bg-destructive/12 text-destructive',
  info: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}
