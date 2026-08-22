import type { ReactNode, MouseEvent } from 'react'
import AiChatTrigger from './AiChatTrigger'
import { isWindowZoomDoubleClickTarget, nativeToggleWindowZoom } from '../lib/nativeWindow'

/** 顶栏最右 AI 入口：竖线与本页按钮分开 */
export function AiChatHeaderSlot({ triggerClassName = '' }: { triggerClassName?: string }) {
  return (
    <div className="shrink-0 flex items-center self-center pl-2 ml-0.5 border-l border-border/60">
      <AiChatTrigger className={triggerClassName} />
    </div>
  )
}

/**
 * 页面顶栏壳：sticky h-14 + 底边框，内层 max-w-4xl 居中容器。
 * - 默认（home / inbox / new）：innerClassName 追加到内层容器（如 flex 布局）
 * - bare（doc 页变体）：不渲染内层容器，className 直接拼到 header
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
  const onDragDoubleClick = (e: MouseEvent) => {
    if (!isWindowZoomDoubleClickTarget(e.target)) return
    nativeToggleWindowZoom()
  }

  if (bare) {
    return (
      <header
        data-drag-region
        onDoubleClick={onDragDoubleClick}
        className={`sticky top-0 z-sticky h-14 border-b border-border/50 bg-background/85 backdrop-blur-md flex items-center gap-1 ${className}`.trim()}
      >
        <div className="flex-1 min-w-0 h-full flex items-center justify-between gap-2 min-h-0">
          {children}
        </div>
        <AiChatHeaderSlot />
      </header>
    )
  }
  return (
    <header
      data-drag-region
      onDoubleClick={onDragDoubleClick}
      className="sticky top-0 z-sticky h-14 border-b border-border/50 bg-background/85 backdrop-blur-md"
    >
      <div className="h-full w-full max-w-4xl mx-auto px-4 sm:px-8 flex items-center gap-3">
        <div className={`min-w-0 flex-1 h-full ${innerClassName}`.trim()}>
          {children}
        </div>
        <AiChatHeaderSlot />
      </div>
    </header>
  )
}
