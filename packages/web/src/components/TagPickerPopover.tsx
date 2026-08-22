/**
 * TagPickerPopover — 标签复用选择浮层（Notion 式）
 *
 * 锚定在触发元素（标签行的「+」药丸）下方：搜索输入 + 按使用次数排序的建议列表
 * （最多 8 条，排除已添加）+ 底部「创建新标签」行。键盘 ↑↓ / Enter / Esc。
 * 视觉语言与 ShareDialog / DocActionsMenu 同款浮层一致，避免行内下拉的锚点错配。
 * 数据：GET /api/v1/tags（每次打开拉取，新建标签立即可见）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Search, Plus, Hash, Loader2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { usePopoverDismiss } from '../hooks/usePopoverDismiss'

const PANEL_W = 280
const MAX_SUGGESTIONS = 8

export interface TagInfo {
  tag: string
  count: number
}

/** 与服务端一致：小写、空白 → 连字符、限长 64 */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64)
}

interface TagPickerPopoverProps {
  anchorRef: RefObject<HTMLElement | null>
  /** 已添加标签（从建议中排除） */
  existing: string[]
  /** 选中（复用或新建）；调用方负责持久化；浮层保持打开便于连续添加 */
  onPick: (tag: string) => void
  onClose: () => void
  /** 持久化进行中：禁用交互，避免连点导致两次 PATCH 基于旧状态互相覆盖 */
  disabled?: boolean
}

export default function TagPickerPopover({ anchorRef, existing, onPick, onClose, disabled = false }: TagPickerPopoverProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [allTags, setAllTags] = useState<TagInfo[] | null>(null)

  // 定位（ShareDialog 同款：锚点下方，视口夹紧）
  useLayoutEffect(() => {
    const el = anchorRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8))
      setPos({ top: r.bottom + 6, left })
    }
  }, [anchorRef])

  // 每次打开拉取一次（保证新建标签立即可见）
  useEffect(() => {
    let cancelled = false
    api.get<{ provider: string; tags: TagInfo[] }>('/tags')
      .then((res) => { if (!cancelled && Array.isArray(res?.tags)) setAllTags(res.tags) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [])

  const q = normalizeTag(query)

  // 建议：排除已添加，子串过滤，保持服务端 count 排序
  const suggestions = useMemo(() => {
    const list = (allTags ?? []).filter((ti) => !existing.includes(ti.tag))
    const filtered = q ? list.filter((ti) => ti.tag.toLowerCase().includes(q)) : list
    return filtered.slice(0, MAX_SUGGESTIONS)
  }, [allTags, existing, q])

  const canCreate = q.length > 0 && !existing.includes(q) && !suggestions.some((s) => s.tag === q)
  const rowCount = suggestions.length + (canCreate ? 1 : 0)
  const clampedActive = Math.min(active, Math.max(0, rowCount - 1))

  const pick = (tag: string) => {
    onPick(tag)
    setQuery('')
    setActive(0)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (rowCount === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % rowCount)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + rowCount) % rowCount)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (clampedActive < suggestions.length) pick(suggestions[clampedActive]!.tag)
      else if (canCreate) pick(q)
    }
  }

  // active 项滚动可见
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-pick-index="${clampedActive}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [clampedActive])

  // 点击外部关闭（Esc 由输入框 keydown 处理；组件 pos 为空即不渲染 → 天然卸载解绑）
  usePopoverDismiss(true, { onClose }, anchorRef, panelRef)

  if (!pos) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('tagPicker.title')}
      className="fixed z-popover w-[280px] max-w-[calc(100vw-16px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-floating animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <Search className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={handleKeyDown}
          placeholder={t('tagPicker.placeholder')}
          disabled={disabled}
          data-no-focus-ring
          className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none disabled:opacity-50"
        />
      </div>

      <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1.5">
        {allTags === null ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px] text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
            {t('common.loading')}
          </div>
        ) : suggestions.length === 0 && !canCreate ? (
          <div className="px-2 py-4 text-center text-[12px] text-muted-foreground">
            {q ? t('tagPicker.noMatch') : t('tagPicker.noTags')}
          </div>
        ) : (
          <>
            {suggestions.map((ti, i) => (
              <button
                key={ti.tag}
                type="button"
                data-pick-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(ti.tag)}
                disabled={disabled}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors disabled:opacity-50 ${
                  clampedActive === i ? 'bg-primary-soft text-foreground' : 'text-foreground/85 hover:bg-[var(--primary-softer)]'
                }`}
              >
                <Hash className="w-3 h-3 text-muted-foreground/60 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-mono">{ti.tag}</span>
                <span className="text-[10.5px] text-muted-foreground/70 tabular-nums shrink-0">×{ti.count}</span>
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                data-pick-index={suggestions.length}
                onMouseEnter={() => setActive(suggestions.length)}
                onClick={() => pick(q)}
                disabled={disabled}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors disabled:opacity-50 ${
                  clampedActive === suggestions.length ? 'bg-primary-soft text-foreground' : 'text-foreground/85 hover:bg-[var(--primary-softer)]'
                }`}
              >
                <Plus className="w-3 h-3 text-muted-foreground/60 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{t('tagPicker.createTag', { tag: q })}</span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-border/60 text-[10.5px] text-muted-foreground/70">
        {t('tagPicker.hint')}
      </div>
    </div>,
    document.body,
  )
}
