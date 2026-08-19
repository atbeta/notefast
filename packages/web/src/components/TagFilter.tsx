/**
 * TagFilter — Home 顶部标签筛选
 *
 * 单击 chip = 只看这一项；⌘/Ctrl+点 = 加/减。顺序保持服务端 count 降序（高频在前）。
 * 默认最多两行，超出用图标展开/收起；选中项留在原位。
 * URL：`?tags=a,b`；多 tag 默认 `tag_match=all`。与 `untagged=1` 互斥。
 * 交/并开关在标题旁（TagMatchHint）。
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronUp, Tag as TagIcon } from 'lucide-react'
import type { TagInfo, TagMatchMode } from '@notefast/core'
import { parseTagMatchMode } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useTranslation } from 'react-i18next'
import { Tooltip } from './ui'
import {
  TAG_CHIP_MAX_ROWS,
  catalogWithSelected,
  chipCountForRows,
  isAdditiveTagClick,
  nextTagSelection,
  readSelectedTags,
} from '../lib/tagFilter'

export interface TagFilterProps {
  onChange?: (tags: string[]) => void
}

const CHIP_WRAP = 'flex flex-wrap gap-x-1.5 gap-y-1.5'
const CHIP_FACE =
  'inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-[11.5px] font-mono'
const TOGGLE_FACE =
  'inline-flex items-center justify-center w-7 h-7 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0'

/** 多选时出现在页标题旁：轻文字切换同时包含 / 包含任一。 */
export function TagMatchHint() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = useMemo(() => readSelectedTags(searchParams), [searchParams])
  const tagMatch = useMemo(() => parseTagMatchMode(searchParams.get('tag_match')), [searchParams])
  if (selected.length < 2) return null

  const setTagMatch = (mode: TagMatchMode) => {
    setSearchParams(
      (prev) => {
        if (mode === 'any') prev.set('tag_match', 'any')
        else prev.delete('tag_match')
        return prev
      },
      { replace: true },
    )
  }

  return (
    <Tooltip label={t('tagFilter.matchHint')}>
      <button
        type="button"
        className="text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors shrink-0"
        aria-label={t('tagFilter.tagMatchMode')}
        aria-pressed={tagMatch === 'any'}
        onClick={() => setTagMatch(tagMatch === 'any' ? 'all' : 'any')}
      >
        {tagMatch === 'any' ? t('tagFilter.matchAny') : t('tagFilter.matchAll')}
      </button>
    </Tooltip>
  )
}

export default function TagFilter({ onChange }: TagFilterProps) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expanded, setExpanded] = useState(false)
  const [collapsedCount, setCollapsedCount] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const { data, loading, error } = useApiQuery(
    () => api.get<{ provider: string; tags: TagInfo[] }>('/tags'),
    [],
  )
  const tags = error ? [] : (data?.tags ?? [])
  const selected = useMemo(() => readSelectedTags(searchParams), [searchParams])
  const untagged =
    searchParams.get('untagged') === '1' || searchParams.get('view') === 'untagged'
  const catalog = useMemo(() => catalogWithSelected(tags, selected), [tags, selected])

  const patchParams = (fn: (prev: URLSearchParams) => void) => {
    setSearchParams(
      (prev) => {
        fn(prev)
        return prev
      },
      { replace: true },
    )
  }

  const writeTags = (next: string[]) => {
    const sorted = [...new Set(next.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort()
    patchParams((prev) => {
      prev.delete('tag')
      prev.delete('untagged')
      if (sorted.length > 0) prev.set('tags', sorted.join(','))
      else prev.delete('tags')
      if (sorted.length < 2) prev.delete('tag_match')
    })
    onChange?.(sorted)
  }

  const handleChipClick = (tag: string, e: MouseEvent) => {
    writeTags(nextTagSelection(selected, tag, isAdditiveTagClick(e)))
  }

  const recompute = useCallback(() => {
    const measure = measureRef.current
    const wrap = wrapRef.current
    if (!measure || !wrap) return
    const chips = measure.querySelectorAll<HTMLElement>('[data-tag-measure]')
    const more = measure.querySelector<HTMLElement>('[data-tag-more-measure]')
    const gapX = Number.parseFloat(getComputedStyle(measure).columnGap) || 6
    const n = chipCountForRows(
      [...chips].map((el) => el.offsetWidth),
      wrap.clientWidth,
      gapX,
      TAG_CHIP_MAX_ROWS,
      more?.offsetWidth ?? 28,
    )
    setCollapsedCount(n)
  }, [catalog])

  useLayoutEffect(() => {
    recompute()
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [recompute])

  useLayoutEffect(() => {
    if (collapsedCount !== null && collapsedCount >= catalog.length) setExpanded(false)
  }, [collapsedCount, catalog.length])

  if (loading && tags.length === 0) return null
  // 「未加标签」与标签筛选互斥：该视图下列出标签 chip 无意义（选中任一标签即会退出 untagged）
  if (untagged) return null
  if (tags.length === 0 && catalog.length === 0) return null

  const limit = collapsedCount ?? catalog.length
  const overflow = limit < catalog.length
  const shown = expanded || !overflow ? catalog : catalog.slice(0, limit)
  const showToggle = overflow

  return (
    <div className="flex items-start gap-1.5 px-1">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0 mt-1.5" strokeWidth={1.75} />
      <div ref={wrapRef} className="relative min-w-0 flex-1">
        {/* 同宽不可见副本：量 chip / 展开按钮宽度，避免折叠后测不全 */}
        <div
          ref={measureRef}
          aria-hidden
          className={`${CHIP_WRAP} invisible absolute inset-x-0 top-0 pointer-events-none`}
        >
          {catalog.map((ti) => (
            <span key={ti.tag} data-tag-measure className={CHIP_FACE}>
              <span>{ti.tag}</span>
              <span className="text-[10px] tabular-nums">{ti.count}</span>
            </span>
          ))}
          <span data-tag-more-measure className={TOGGLE_FACE} />
        </div>
        <div className={CHIP_WRAP}>
          {shown.map((ti) => {
            const isSelected = selected.includes(ti.tag)
            return (
              <Tooltip
                key={ti.tag}
                label={isSelected ? t('tagFilter.chipHintSelected') : t('tagFilter.chipHint')}
              >
                <button
                  type="button"
                  onClick={(e) => handleChipClick(ti.tag, e)}
                  onContextMenu={(e) => { if (e.ctrlKey) e.preventDefault() }}
                  aria-pressed={isSelected}
                  className={`${CHIP_FACE} transition-colors ${
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 text-foreground/75 hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <span>{ti.tag}</span>
                  <span
                    className={`text-[10px] tabular-nums ${isSelected ? 'text-background/60' : 'text-muted-foreground/55'}`}
                  >
                    {ti.count}
                  </span>
                </button>
              </Tooltip>
            )
          })}
          {showToggle && (
            <Tooltip label={expanded ? t('tagFilter.collapseTags') : t('tagFilter.expandTags')}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t('tagFilter.collapseTags') : t('tagFilter.expandTags')}
                onClick={() => setExpanded((v) => !v)}
                className={TOGGLE_FACE}
              >
                {expanded
                  ? <ChevronUp className="w-3.5 h-3.5" strokeWidth={1.75} />
                  : <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.75} />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
