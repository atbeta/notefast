/**
 * 时间格式化工具（由 doc / inbox / DocList / MarkdownEditor 四处本地实现收敛而来）。
 * 阈值与文案逐字符保持各调用点现状；差异用参数区分，不改行为。
 */

/**
 * 列表/文档相对时间：刚刚 → N 分钟前 → N 小时前 → N 天前 → 本地化日期。
 * dateStyle='plain'（默认）：超 7 天用 toLocaleDateString('zh-CN')（inbox / DocList 现状）；
 * dateStyle='long'：超 7 天带 year/month/day options，且无效日期返回 ''（doc 页现状）。
 */
export function formatRelative(dateStr: string, dateStyle: 'plain' | 'long' = 'plain'): string {
  const date = new Date(dateStr)
  if (dateStyle === 'long' && !Number.isFinite(date.getTime())) return ''
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHr < 24) return `${diffHr} 小时前`
  if (diffDay < 7) return `${diffDay} 天前`
  return dateStyle === 'long'
    ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
    : date.toLocaleDateString('zh-CN')
}

/** 编辑器加载/草稿时间的秒级相对时间：刚刚 → N 秒前 → N 分钟前 → 当天 HH:MM */
export function relativeTime(date: Date | null): string {
  if (!date) return '—'
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 5) return '刚刚'
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
