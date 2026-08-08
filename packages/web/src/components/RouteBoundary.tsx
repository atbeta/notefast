/**
 * 路由级错误边界：把崩溃隔离到一段内容里，
 * Layout（侧栏 / 顶栏 / 命令面板 / Toast）继续可用。
 *
 * 与 root ErrorBoundary 的差异：
 *  - 紧凑（嵌入 content 区，不撑满视口）
 *  - 不暴露 stack（user-facing 页面，stack 是噪音）
 *  - 自动从 useLocation 取 path 作为出错位置标识（也支持 name 覆写）
 */
import { useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import ErrorBoundary from './ErrorBoundary'

interface Props {
  children: ReactNode
  /** 出错位置的可读标识（不传则用当前 pathname） */
  name?: string
}

export default function RouteBoundary({ name, children }: Props) {
  const location = useLocation()
  const label = name ?? location.pathname

  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div
          role="alert"
          className="flex flex-col items-center justify-center px-6 py-16 gap-3 text-center"
        >
          <div className="text-[14px] font-medium text-foreground">这段内容渲染出错</div>
          <div className="text-[11.5px] text-muted-foreground font-mono">{label}</div>
          <div className="text-[11.5px] text-destructive/80 break-all max-w-md leading-relaxed">
            {error.message || String(error)}
          </div>
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={reset}
              className="btn-primary-custom text-[12.5px]"
            >
              重试这段
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = '/' }}
              className="btn-ghost-custom text-[12.5px]"
            >
              返回首页
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}