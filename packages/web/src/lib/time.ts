/**
 * 时间格式化工具（由 doc / inbox / DocList / MarkdownEditor 四处本地实现收敛而来）。
 * 阈值与文案逐字符保持各调用点现状；差异用参数区分，不改行为。
 */

import i18next from '../i18n'

/** 当前生效语言（i18next 切换后实时反映；组件侧随 useTranslation/useLocale 重渲染） */
export function currentLocale(): string {
  return i18next.resolvedLanguage || i18next.language || 'zh-CN'
}

/** 自动生成的占位标题（无标题 / 中英日期短标题），可被 AI 建议覆盖 */
export function isPlaceholderDocTitle(title: string, untitled: string): boolean {
  const trimmed = title.trim()
  if (!trimmed || trimmed === untitled) return true
  if (/^\d{1,2}月\d{1,2}日$/.test(trimmed)) return true
  if (/^[A-Z][a-z]{2,8} \d{1,2}(, \d{4})?$/.test(trimmed)) return true
  return false
}

/** SQLite datetime('now') 返回 "YYYY-MM-DD HH:MM:SS" 不带时区标记。
 *  JavaScript new Date(不带时区字符串) 会当成本地时间解析，在 UTC+8 产生 +8h 偏差。
 *  此处对无时区信息的日期字符串统一补齐 Z 按 UTC 解读。 */
export function toUTCDate(s: string): Date {
  const str = s.trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z')
  }
  return new Date(str)
}

/**
 * 列表/文档相对时间：刚刚 → N 分钟前 → N 小时前 → N 天前 → 本地化日期。
 * dateStyle='plain'（默认）：超 7 天用 toLocaleDateString('zh-CN')（inbox / DocList 现状）；
 * dateStyle='long'：超 7 天带 year/month/day options，且无效日期返回 ''（doc 页现状）。
 */
export function formatRelative(dateStr: string, dateStyle: 'plain' | 'long' = 'plain'): string {
  const date = toUTCDate(dateStr)
  if (dateStyle === 'long' && !Number.isFinite(date.getTime())) return ''
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return i18next.t('time.justNow')
  if (diffMin < 60) return i18next.t('time.minutesAgo', { n: diffMin })
  if (diffHr < 24) return i18next.t('time.hoursAgo', { n: diffHr })
  if (diffDay < 7) return i18next.t('time.daysAgo', { n: diffDay })
  return dateStyle === 'long'
    ? date.toLocaleDateString(currentLocale(), { year: 'numeric', month: 'short', day: 'numeric' })
    : date.toLocaleDateString(currentLocale())
}

/** 编辑器加载/草稿时间的秒级相对时间：刚刚 → N 秒前 → N 分钟前 → 当天 HH:MM */
export function relativeTime(date: Date | null): string {
  if (!date) return '—'
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 5) return i18next.t('time.justNow')
  if (diff < 60) return i18next.t('time.secondsAgo', { n: diff })
  if (diff < 3600) return i18next.t('time.minutesAgo', { n: Math.floor(diff / 60) })
  return date.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * SQLite 时间字符串的本地化绝对时间（历史记录用）：
 * 按 UTC 解读（toUTCDate）后转系统时区显示，避免 +8h 偏差。
 * 当天显示 HH:MM:SS，跨天带日期；无效输入返回 '—'。
 */
export function formatSqliteDateTime(dateStr: string): string {
  const date = toUTCDate(dateStr)
  if (!Number.isFinite(date.getTime())) return '—'
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString(currentLocale(), {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
}

/**
 * ISO 时间字符串（带 Z）的本地化显示：new Date() 按 UTC 解析后转系统时区。
 * 备份/同步等后端返回 ISO 字符串的通用格式化。
 */
export function formatIsoDateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString(currentLocale(), {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
}
