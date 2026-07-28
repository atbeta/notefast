import type { ReactNode } from 'react'

/**
 * 页面顶栏壳：sticky h-14 + 底边框，内层 max-w-4xl 居中容器。
 * - 默认（home / inbox / new）：innerClassName 追加到内层容器（如 flex 布局）
 * - bare（doc 页变体）：不渲染内层容器，className 直接拼到 header，
 *   header 自身即 flex 工具栏（shrink-0 + px-6）
 */
export default function PageHeader({
  children,
  innerClassName = '',
  bare = false,
  className = '',
}: {
  children: ReactNode
  /** 追加到内层 max-w-4xl 容器的类名（bare 时无效） */
  innerClassName?: string
  /** true：去掉内层容器，className 直接作用于 header */
  bare?: boolean
  /** bare 模式下追加到 header 的类名 */
  className?: string
}) {
  if (bare) {
    return (
      <header className={`sticky top-0 z-10 h-14 border-b border-border/50 bg-background/85 backdrop-blur-md ${className}`.trim()}>
        {children}
      </header>
    )
  }
  return (
    <header className="sticky top-0 z-10 h-14 border-b border-border/50 bg-background/85 backdrop-blur-md">
      <div className={`h-full w-full max-w-4xl mx-auto px-8 ${innerClassName}`.trim()}>
        {children}
      </div>
    </header>
  )
}
