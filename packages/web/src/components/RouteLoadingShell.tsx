/**
 * 路由 lazy 加载占位（Suspense fallback）。
 *
 * 视觉与 RouteTransition 的 200ms 淡出配合：留出 12vh 上边距与路由内容区
 * 的顶部对齐。冷加载给居中文案，避免只有一个无名 spinner。
 */

import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function RouteLoadingShell() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-2 pt-[12vh] text-muted-foreground"
    >
      <Loader2 className="w-5 h-5 animate-spin text-primary" strokeWidth={1.75} />
      <span className="text-base">{t('common.loading')}</span>
    </div>
  )
}
