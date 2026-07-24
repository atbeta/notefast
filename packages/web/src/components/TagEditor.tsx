/**
 * TagEditor — 文档标签编辑
 *
 * 纯展示 + 行内编辑：
 * - 点击 chip 的 × 删除 tag（乐观更新）
 * - 输入框敲 Enter / 失焦提交新 tag（自动 normalize）
 * - 用 api 请求 → 自动带 Authorization header
 */

import { useState } from 'react'
import { Tag as TagIcon, X, Plus, Loader2 } from 'lucide-react'
import { api } from '../hooks/useAPI'

export interface TagEditorProps {
  docId: string
  tags: string[]
  onChange: (next: string[]) => void
}

export default function TagEditor({ docId, tags, onChange }: TagEditorProps) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const persist = async (next: string[]) => {
    setSaving(true)
    try {
      await api.patch(`/docs/${docId}/tags`, { tags: next })
      onChange(next)
    } catch {
      // 失败由外层 toast / 上层逻辑处理；这里静默回退
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    const raw = draft.trim()
    if (!raw) return
    // 本地先去重 + normalize（与后端规则保持一致：小写、空格 → -）
    const normalized = raw.toLowerCase().replace(/\s+/g, '-').slice(0, 64)
    if (!normalized || tags.includes(normalized)) {
      setDraft('')
      return
    }
    const next = [...tags, normalized].sort()
    setDraft('')
    await persist(next)
  }

  const handleRemove = async (tag: string) => {
    const next = tags.filter((t) => t !== tag)
    await persist(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 mr-0.5" strokeWidth={1.75} />
      {tags.map((t) => (
        <span
          key={t}
          className="group/chip inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11.5px] bg-muted/60 hover:bg-muted text-foreground/85 hover:text-foreground transition-colors"
          title={t}
        >
          <span className="font-mono">{t}</span>
          <button
            type="button"
            onClick={() => handleRemove(t)}
            disabled={saving}
            className="w-4 h-4 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive hover:bg-background/60 transition-colors disabled:opacity-40"
            aria-label={`移除标签 ${t}`}
          >
            <X className="w-3 h-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <div className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full border border-dashed border-border/70 hover:border-foreground/30 transition-colors">
        <Plus className="w-3 h-3 text-muted-foreground/60" strokeWidth={2} />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAdd()
            } else if (e.key === 'Escape') {
              setDraft('')
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          onBlur={() => {
            if (draft.trim()) handleAdd()
          }}
          placeholder="加标签"
          disabled={saving}
          className="bg-transparent border-none outline-none text-[11.5px] w-16 placeholder:text-muted-foreground/40 focus:w-28 transition-[width] duration-200"
        />
        {saving && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/60" />}
      </div>
    </div>
  )
}