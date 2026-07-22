/**
 * ActionButton — 统一「执行异步操作 + 反馈」按钮
 *
 * 封装了 UI 中 90% 的按钮交互：点击 → 执行 async → 三态视觉 + 顶部 toast
 *
 * 行为契约：
 *   1. idle 状态：点击后立刻进入 loading，按钮内显示 spinner + 「处理中…」
 *   2. 成功：触发 successToast（默认 toast.success），按钮短暂亮绿（justSaved），再回 idle
 *   3. 失败：触发 errorToast，按钮回到 idle，让用户重试
 *   4. 抛错：可在 onAction 内 try/catch 后正常 reject；也可以包一层 inlineValidate 先校验
 *
 * 用例：
 *   <ActionButton
 *     successToast={{ title: '已保存', description: '... ' }}
 *     errorToast={{ title: '保存失败' }}
 *     onAction={async () => { await api.put(...) }}
 *   >保存配置</ActionButton>
 */

import { useState } from 'react'
import { Button, type ButtonVariant, type ButtonSize } from './Button'
import { useToast } from './Toast'
import type { ToastInput } from './Toast'

export interface ActionButtonProps {
  onAction: () => Promise<unknown> | unknown
  children?: React.ReactNode
  /** 点击前先校验（如校验表单），返回 false / throw 阻止发送 */
  before?: (() => boolean | Promise<boolean>) | (() => void | Promise<void>)
  successToast?: ToastInput
  /** 关掉 successToast（仍会触发 justSaved 视觉） */
  silentSuccess?: boolean
  errorToast?: ToastInput | ((err: unknown) => ToastInput)
  /** 关掉 errorToast */
  silentError?: boolean
  variant?: ButtonVariant
  size?: ButtonSize
  /** 与 Button 一致；主要用于 "未填表单时禁用" 这类场景 */
  disabled?: boolean
  fullWidth?: boolean
  icon?: React.ReactNode
  /** 自定义类名 */
  className?: string
  /** loading 时彻底禁用 */
  blockOnLoading?: boolean
  onAfter?: (success: boolean, value: unknown) => void
}

export function ActionButton({
  onAction,
  before,
  successToast,
  silentSuccess,
  errorToast,
  silentError,
  variant,
  size,
  disabled,
  fullWidth,
  icon,
  className,
  blockOnLoading = true,
  onAfter,
  children,
}: ActionButtonProps) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleClick = () => {
    if (loading && blockOnLoading) return
    void (async () => {
      if (before) {
        try {
          const r = await before()
          if (r === false) return
        } catch {
          return
        }
      }
      setLoading(true)
      setSaved(false)
      try {
        const value = await onAction()
        if (!silentSuccess && successToast) {
          toast.success(successToast)
        }
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
        onAfter?.(true, value)
      } catch (err) {
        if (!silentError) {
          let t: ToastInput | undefined
          if (errorToast) {
            t = typeof errorToast === 'function' ? errorToast(err) : errorToast
            if (typeof t === 'string') t = { title: t }
          } else {
            t = {
              title: '操作失败',
              description: err instanceof Error ? err.message : String(err),
            }
          }
          if (t) toast.error(t)
        }
        onAfter?.(false, err)
      } finally {
        setLoading(false)
      }
    })()
  }

  return (
    <Button
      variant={variant}
      size={size}
      loading={loading}
      justSaved={saved}
      disabled={disabled}
      fullWidth={fullWidth}
      icon={icon}
      onClick={handleClick}
      className={className}
    >
      {children ?? '保存'}
    </Button>
  )
}
