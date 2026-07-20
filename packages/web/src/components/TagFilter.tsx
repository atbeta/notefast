/**
 * TagFilter — Home 顶部标签筛选
 *
 * 拉一次 `GET /api/v1/tags`（在 hooks 里缓存 + 简单 refresh），
 * 渲染成可点击的 chip；点击 toggle 当前选中 tag，并把 tag 写入 URL `?tag=xxx`。
 *
 * 多选暂不做（NOT-AND / AND 容易混淆）；要做也是单选 "no tag" / "tag A" 的关系。
 */

import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tag as TagIcon } from 'lucide-react'
import type { TagInfo } from '@notefast/core'
import { api } from '../hooks/useAPI'

export interface TagFilterProps {
  /** 当 tag 选中变化时通知外层去 refetch docs/list */
  onChange?: (tag: string | null) => void
}

export default function TagFilter({ onChange }: TagFilterProps) {
  const [tags, setTags] = useState<TagInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  const active = searchParams.get('tag') || ''

  useEffect(() => {
    setLoading(true)
    api
      .get<{ provider: string; tags: TagInfo[] }>('/tags')
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]))
      .finally(() => setLoading(false))
  }, [])

  const handleToggle = (tag: string) => {
    const next = active === tag ? '' : tag
    setSearchParams(
      (prev) => {
        if (next) prev.set('tag', next)
        else prev.delete('tag')
        return prev
      },
      { replace: true },
    )
    onChange?.(next || null)
  }

  if (loading && tags.length === 0) return null
  if (tags.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 mr-0.5" strokeWidth={1.75} />
      {tags.map((t) => {
        const selected = active === t.tag
        return (
          <button
            key={t.tag}
            type="button"
            onClick={() => handleToggle(t.tag)}
            aria-pressed={selected}
            className={`group inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-[11.5px] font-mono transition-colors ${
              selected
                ? 'bg-foreground text-background'
                : 'bg-muted/50 text-foreground/75 hover:bg-muted hover:text-foreground'
            }`}
          >
            <span>{t.tag}</span>
            <span
              className={`text-[10px] tabular-nums ${selected ? 'text-background/60' : 'text-muted-foreground/55'}`}
            >
              {t.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}