/**
 * Button — 统一按钮原语
 *
 * 4 个变体：primary / secondary / ghost / danger
 * 4 个状态：idle / loading / success / (disabled 是普通 attribute)
 *
 * 使用：
 *   <Button variant="primary" loading={saving}>保存</Button>
 *   <Button variant="primary" loading={saving} justSaved={savedFlash}>保存</Button>
 *   <Button variant="danger" onClick={handleDelete}>删除</Button>
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** loading=true → 半透明 + spinner + 文字不变（避免抖动），禁用 onClick */
  loading?: boolean
  /** justSaved=true → 绿色 + ✓，2.5s 内复位。常配合 loading={false} 使用 */
  justSaved?: boolean
  /** 显示在左侧的额外 icon（loading/justSaved 时被覆盖） */
  icon?: ReactNode
  fullWidth?: boolean
}

const VARIANT_BASE: Record<ButtonVariant, string> = {
  primary: 'btn-primary-custom',
  secondary:
    'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-btn)] border border-[rgb(var(--border))] bg-[rgb(var(--card))] text-[rgb(var(--ink))] hover:bg-accent active:scale-[0.97] transition-all duration-150',
  ghost:
    'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-btn)] border border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-all duration-150',
  danger:
    'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-btn)] border border-transparent bg-transparent text-destructive hover:bg-destructive/10 active:scale-[0.97] transition-all duration-150',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 min-h-0 px-2.5 text-[12px]',
  md: 'h-8 min-h-0 px-3.5 text-sm',
  lg: 'h-10 min-h-0 px-5 text-[14px]',
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading,
  justSaved,
  icon,
  disabled,
  fullWidth,
  className = '',
  ...rest
}: ButtonProps) {
  const { t } = useTranslation()
  const isEffectivelyDisabled = disabled || loading

  // 主按钮才有 justSaved 视觉强调；其他变体保持简洁
  const showSuccessAccent = justSaved && variant === 'primary'

  let visualCls = ''
  if (showSuccessAccent) {
    visualCls = '!bg-emerald-600 !text-white !border-emerald-600 shadow-[var(--shadow-btn)]'
  } else if (loading) {
    visualCls = 'opacity-70 cursor-wait'
  }

  const baseCls =
    `${VARIANT_BASE[variant]} ${SIZES[size]} font-medium leading-[1.2] ` +
    `transition-colors duration-150 focus-visible:outline-none ` +
    `disabled:opacity-40 disabled:cursor-not-allowed ` +
    `min-w-[88px] ` +
    (fullWidth ? 'w-full ' : '') +
    visualCls + ' ' + className

  const label = loading ? t('btn.processing') : justSaved ? t('btn.done') : children
  const leading = loading ? (
    <Loader2 className="w-3.5 h-3.5 animate-spin" />
  ) : justSaved ? (
    <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
  ) : icon ? (
    icon
  ) : null

  return (
    <button
      type="button"
      {...rest}
      disabled={isEffectivelyDisabled}
      aria-busy={loading ? true : undefined}
      aria-live="polite"
      className={baseCls}
    >
      {leading}
      {label}
    </button>
  )
}
