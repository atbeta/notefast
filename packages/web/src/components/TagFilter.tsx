/**
 * TagFilter — Home 顶部标签多选筛选
 *
 * URL：`?tags=a,b`；多 tag 默认 `tag_match=all`（同时包含 / AND）。
 * 切换「包含任一」时写入 `tag_match=any`。与 `untagged=1` 互斥。
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tag as TagIcon } from 'lucide-react'
import type { TagInfo, TagMatchMode } from '@notefast/core'
import { parseTagMatchMode } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useTranslation } from 'react-i18next'

export interface TagFilterProps {
  onChange?: (tags: string[]) => void
}

function readSelectedTags(params: URLSearchParams): string[] {
  const fromMulti = (params.get('tags') || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  const single = (params.get('tag') || '').trim().toLowerCase()
  const set = new Set(fromMulti)
  if (single) set.add(single)
  return Array.from(set).sort()
}

function TagMatchToggle({
  mode,
  onChange,
}: {
  mode: TagMatchMode
  onChange: (mode: TagMatchMode) => void
}) {
  const { t } = useTranslation()
  const btn = (active: boolean) =>
    `px-2 py-0.5 rounded-[5px] transition-colors ${
      active
        ? 'bg-primary text-primary-foreground font-medium shadow-sm'
        : 'text-muted-foreground/70 hover:text-foreground'
    }`

  return (
    <div
      className="inline-flex items-center rounded-md border border-border/60 bg-muted/30 p-0.5 text-[11px] shrink-0"
      role="group"
      aria-label={t('tagFilter.tagMatchMode')}
    >
      <button
        type="button"
        className={btn(mode === 'all')}
        aria-pressed={mode === 'all'}
        onClick={() => onChange('all')}
      >
        {t('tagFilter.matchAll')}
      </button>
      <button
        type="button"
        className={btn(mode === 'any')}
        aria-pressed={mode === 'any'}
        onClick={() => onChange('any')}
      >
        {t('tagFilter.matchAny')}
      </button>
    </div>
  )
}

export default function TagFilter({ onChange }: TagFilterProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data, loading, error } = useApiQuery(
    () => api.get<{ provider: string; tags: TagInfo[] }>('/tags'),
    [],
  )
  // 原 .catch(() => setTags([])) 语义：失败时视为无标签（组件整体不渲染）
  const tags = error ? [] : (data?.tags ?? [])
  const selected = useMemo(() => readSelectedTags(searchParams), [searchParams])
  const tagMatch = useMemo(() => parseTagMatchMode(searchParams.get('tag_match')), [searchParams])
  const untagged =
    searchParams.get('untagged') === '1' || searchParams.get('view') === 'untagged'

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
    const sorted = [...new Set(next.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()
    patchParams((prev) => {
      prev.delete('tag')
      prev.delete('untagged')
      if (sorted.length > 0) prev.set('tags', sorted.join(','))
      else {
        prev.delete('tags')
        prev.delete('tag_match')
      }
    })
    onChange?.(sorted)
  }

  const setTagMatch = (mode: TagMatchMode) => {
    patchParams((prev) => {
      if (mode === 'any') prev.set('tag_match', 'any')
      else prev.delete('tag_match')
    })
  }

  const handleToggle = (tag: string) => {
    if (selected.includes(tag)) {
      writeTags(selected.filter((t) => t !== tag))
    } else {
      writeTags([...selected, tag])
    }
  }

  if (loading && tags.length === 0) return null
  // 「未加标签」与标签筛选互斥：该视图下列出标签 chip 无意义（选中任一标签即会退出 untagged）
  if (untagged) return null
  if (tags.length === 0) return null

  const showMatchToggle = selected.length >= 2

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-1">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" strokeWidth={1.75} />
      {showMatchToggle && (
        <TagMatchToggle mode={tagMatch} onChange={setTagMatch} />
      )}
      {tags.map((t) => {
        const isSelected = !untagged && selected.includes(t.tag)
        return (
          <button
            key={t.tag}
            type="button"
            onClick={() => handleToggle(t.tag)}
            aria-pressed={isSelected}
            className={`group inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-[11.5px] font-mono transition-colors ${
              isSelected
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-foreground/75 hover:bg-muted hover:text-foreground'
            }`}
          >
            <span>{t.tag}</span>
            <span
              className={`text-[10px] tabular-nums ${isSelected ? 'text-background/60' : 'text-muted-foreground/55'}`}
            >
              {t.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}
