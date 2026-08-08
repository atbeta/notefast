/**
 * 路由 lazy 加载占位（Suspense fallback）。
 *
 * 视觉与 RouteTransition 的 200ms 淡出配合：留出 12vh 上边距与路由内容区
 * 的顶部对齐，spinner 选主题色，整体延迟 ≤ 一个 ~16ms 帧（chunk 命中缓存时
 * 用户根本看不到；冷加载时也是即时 spinner，无骨架屏闪一帧）。
 */

import { Loader2 } from 'lucide-react'

export default function RouteLoadingShell() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center pt-[12vh] text-muted-foreground"
    >
      <Loader2 className="w-5 h-5 animate-spin text-primary" strokeWidth={1.75} />
    </div>
  )
}