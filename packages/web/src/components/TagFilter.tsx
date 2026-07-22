/**
 * TagFilter — Home 顶部标签多选筛选
 *
 * URL：`?tags=a,b`（排序后稳定）；与 `untagged=1` 互斥。
 * 兼容旧 `?tag=xxx`（读入时并入 tags）。
 */

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tag as TagIcon } from 'lucide-react'
import type { TagInfo } from '@notefast/core'
import { api } from '../hooks/useAPI'

export interface TagFilterProps {
  /** 选中 tags 变化时通知外层 refetch */
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

export default function TagFilter({ onChange }: TagFilterProps) {
  const [tags, setTags] = useState<TagInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = useMemo(() => readSelectedTags(searchParams), [searchParams])
  const untagged = searchParams.get('untagged') === '1'

  useEffect(() => {
    setLoading(true)
    api
      .get<{ provider: string; tags: TagInfo[] }>('/tags')
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]))
      .finally(() => setLoading(false))
  }, [])

  const writeTags = (next: string[]) => {
    const sorted = [...new Set(next.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()
    setSearchParams(
      (prev) => {
        prev.delete('tag')
        prev.delete('untagged')
        if (sorted.length > 0) prev.set('tags', sorted.join(','))
        else prev.delete('tags')
        return prev
      },
      { replace: true },
    )
    onChange?.(sorted)
  }

  const handleToggle = (tag: string) => {
    if (selected.includes(tag)) {
      writeTags(selected.filter((t) => t !== tag))
    } else {
      writeTags([...selected, tag])
    }
  }

  if (loading && tags.length === 0) return null
  if (tags.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 mr-0.5" strokeWidth={1.75} />
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
                ? 'bg-foreground text-background'
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
