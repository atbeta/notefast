/**
 * Toast — 短暂通知系统
 *
 * 设计目标：
 * - 视觉上用「圆形彩色 icon box + 左侧 4px 色带 + 柔和阴影」传达状态，跟 Sonner/shadcn 一致
 * - 进入用 spring 感（cubic-bezier(0.16, 1, 0.3, 1)），退场用 ease-in（~180ms），不抢戏
 * - 堆叠从右上往下，hover 不暂停（用户暂停偏干扰），默认 4s 自动消失
 * - action handler 可选（比如复制错误信息、撤销操作等）
 * - 支持「promise 包装」：toast.promise(promise, { loading, success, error })，常用于 API 调用
 *
 * 使用：
 *   const toast = useToast()
 *   toast.success({ title: '已保存', description: 'Chat @ api.openai.com' })
 *   toast.error({ title: '保存失败', description: '...' })
 *   await toast.promise(api.put(...), { loading: 'Saving…', success: 'Saved', error: 'Failed' })
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X, Loader2 } from 'lucide-react'

export type ToastVariant = 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  title: string
  description?: ReactNode
  /** 自动消失毫秒；0 表示不自动消失。默认 4000。loading 默认 0（要手动替换） */
  durationMs?: number
  action?: ToastAction
}

interface ToastRecord extends Required<Omit<ToastInput, 'action' | 'description'>> {
  id: string
  description?: ReactNode
  variant: ToastVariant
  action?: ToastAction
  /** 用于强制更新 variant（如 loading → success）。随 promise 自动调整 */
  maxAge: number
  createdAt: number
}

interface ToastApi {
  success: (t: ToastInput) => string
  error: (t: ToastInput) => string
  info: (t: ToastInput) => string
  warning: (t: ToastInput) => string
  loading: (t: ToastInput) => string
  /** 创建一个 toast，跟踪 promise 的状态自动切换。返回的 id 可用于后面 dismiss() */
  promise: <T>(
    p: Promise<T> | (() => Promise<T>),
    msgs: { loading: string; success: string | ToastInput; error: string | ((e: unknown) => string | ToastInput) },
  ) => Promise<T>
  dismiss: (id: string) => void
  /** 全清空 */
  clear: () => void
}

const ToastContext = createContext<ToastApi | null>(null)

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3800,
  error: 6000, // 错误更显眼，给用户充足时间看清/操作
  info: 3800,
  warning: 5000,
  loading: 0, // 不自动消失，必须被替换为其它 variant
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const counter = useRef(0)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const clearTimer = (id: string) => {
    const t = timersRef.current.get(id)
    if (t) {
      clearTimeout(t)
      timersRef.current.delete(id)
    }
  }

  const dismiss = useCallback((id: string) => {
    clearTimer(id)
    setToasts((cur) => (cur.find((t) => t.id === id) ? cur.map((t) => (t.id === id ? { ...t, _exiting: true } as ToastRecord & { _exiting?: boolean } : t)) : cur))
    // 退场动画后真正移除
    setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== id))
    }, 200)
  }, [])

  const push = useCallback(
    (variant: ToastVariant, t: ToastInput): string => {
      const id = `t-${++counter.current}`
      const duration = t.durationMs ?? DEFAULT_DURATION[variant]
      const rec: ToastRecord = {
        id,
        title: t.title,
        description: t.description,
        action: t.action,
        variant,
        durationMs: duration,
        maxAge: Date.now() + (duration || Number.POSITIVE_INFINITY),
        createdAt: Date.now(),
      }
      setToasts((cur) => [...cur, rec].slice(-5)) // 最多堆 5 条
      if (duration > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }
      return id
    },
    [dismiss],
  )

  // 无 createContext 拷贝这些
  const update = useCallback(
    (id: string, patch: Partial<ToastInput & { variant: ToastVariant; durationMs: number }>) => {
      setToasts((cur) =>
        cur.map((t) => {
          if (t.id !== id) return t
          // 切换到 success/error 重置计时器
          const nextVariant = patch.variant ?? t.variant
          const nextDuration = patch.durationMs ?? (patch.variant ? DEFAULT_DURATION[patch.variant] : t.durationMs)
          clearTimer(id)
          if (nextDuration > 0) {
            timersRef.current.set(
              id,
              setTimeout(() => dismiss(id), nextDuration),
            )
          }
          return {
            ...t,
            ...patch,
            variant: nextVariant,
            durationMs: nextDuration,
            maxAge: Date.now() + (nextDuration || Number.POSITIVE_INFINITY),
          }
        }),
      )
    },
    [dismiss],
  )

  const toMsg = (m: string | ToastInput): ToastInput =>
    typeof m === 'string' ? { title: m } : m

  const api = useMemo<ToastApi>(
    () => ({
      success: (t) => push('success', t),
      error: (t) => push('error', t),
      info: (t) => push('info', t),
      warning: (t) => push('warning', t),
      loading: (t) => push('loading', t),
      promise: async <T,>(p: Promise<T> | (() => Promise<T>), msgs: { loading: string; success: string | ToastInput; error: string | ((e: unknown) => string | ToastInput) }): Promise<T> => {
        const id = push('loading', toMsg(msgs.loading))
        const run = typeof p === 'function' ? p : () => p
        try {
          const result = await run()
          update(id, { ...toMsg(msgs.success), variant: 'success' })
          return result
        } catch (e) {
          const msg = typeof msgs.error === 'function' ? msgs.error(e) : msgs.error
          const input = toMsg(msg)
          update(id, { ...input, variant: 'error', description: input.description ?? (e instanceof Error ? `: ${e.message}` : '') })
          throw e
        }
      },
      dismiss,
      clear: () => {
        setToasts([])
        timersRef.current.forEach(clearTimeout)
        timersRef.current.clear()
      },
    }),
    [push, update, dismiss],
  )

  // 卸载时清掉所有 timer
  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout)
      timersRef.current.clear()
    },
    [],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[]
  onDismiss: (id: string) => void
}) {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastRecord
  onDismiss: (id: string) => void
}) {
  const { id, title, description, variant, action, durationMs, createdAt } = toast
  const exiting = (toast as ToastRecord & { _exiting?: boolean })._exiting === true

  // 进度条剩余时间通过 CSS variable + keyframe 控制
  const cssDuration = durationMs > 0 ? `${durationMs}ms` : '0ms'

  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      data-variant={variant}
      className={`relative overflow-hidden rounded-[10px] bg-card text-card-foreground border border-border/70 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.18),0_2px_4px_-2px_rgba(0,0,0,0.06)] ${
        exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      {/* 左侧色带 */}
      <div
        aria-hidden
        className={`absolute left-0 top-0 bottom-0 w-1 ${barClass(variant)}`}
      />
      <div className="pl-4 pr-2 py-3 flex items-start gap-3">
        <div className={`shrink-0 w-7 h-7 rounded-full grid place-items-center ${iconBoxClass(variant)}`}>
          {variant === 'loading' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Icon variant={variant} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium leading-snug">{title}</div>
          {description && (
            <div className="mt-0.5 text-[12px] text-muted-foreground leading-snug break-words">
              {description}
            </div>
          )}
          {action && (
            <button
              type="button"
              onClick={() => {
                action.onClick()
                onDismiss(id)
              }}
              className="mt-1.5 text-[12px] font-medium text-primary hover:text-primary/80 transition-colors"
            >
              {action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(id)}
          aria-label="关闭"
          className="shrink-0 -mr-1 -mt-1 p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {durationMs > 0 && variant !== 'loading' && (
        <div
          aria-hidden
          className={`absolute left-0 bottom-0 h-[2px] w-full origin-left ${progressClass(variant)}`}
          style={{
            animation: `toast-progress ${cssDuration} linear forwards`,
            animationDelay: `-${Math.max(0, Date.now() - createdAt)}ms`,
          }}
        />
      )}
    </div>
  )
}

function Icon({ variant }: { variant: ToastVariant }) {
  const cls = 'w-3.5 h-3.5'
  switch (variant) {
    case 'success':
      return <CheckCircle2 className={cls} strokeWidth={2.25} />
    case 'error':
      return <AlertCircle className={cls} strokeWidth={2.25} />
    case 'info':
      return <Info className={cls} strokeWidth={2.25} />
    case 'warning':
      return <AlertTriangle className={cls} strokeWidth={2.25} />
    case 'loading':
      return null
  }
}

function barClass(v: ToastVariant): string {
  switch (v) {
    case 'success':
      return 'bg-emerald-500'
    case 'error':
      return 'bg-destructive'
    case 'info':
      return 'bg-sky-500'
    case 'warning':
      return 'bg-amber-500'
    case 'loading':
      return 'bg-primary'
  }
}

function iconBoxClass(v: ToastVariant): string {
  switch (v) {
    case 'success':
      return 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
    case 'error':
      return 'bg-destructive/12 text-destructive'
    case 'info':
      return 'bg-sky-500/12 text-sky-600 dark:text-sky-400'
    case 'warning':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    case 'loading':
      return 'bg-primary/12 text-primary'
  }
}

function progressClass(v: ToastVariant): string {
  switch (v) {
    case 'success':
      return 'bg-emerald-500/50'
    case 'error':
      return 'bg-destructive/60'
    case 'info':
      return 'bg-sky-500/60'
    case 'warning':
      return 'bg-amber-500/60'
    case 'loading':
      return 'bg-primary/60'
  }
}
