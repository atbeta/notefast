/**
 * TagEditor — 文档标签编辑
 *
 * 纯展示 + 行内编辑：
 * - 点击 chip 的 × 删除 tag（乐观更新）
 * - 点「+」打开 TagPickerPopover：搜索/复用已有标签或创建新标签
 * - 用 api 请求 → 自动带 Authorization header
 */

import { useState, useRef } from 'react'
import { Tag as TagIcon, X, Plus, Loader2, Folder } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useTranslation } from 'react-i18next'
import TagPickerPopover from './TagPickerPopover'
import { Tooltip } from './ui'

export interface TagEditorProps {
  docId: string
  tags: string[]
  onChange: (next: string[]) => void
}

/** 首枚标签 = Markdown 归档目录；只放小图标，不占文案空间 */
export function ArchiveFolderCue() {
  const { t } = useTranslation()
  const hint = t('tagEditor.archiveFolderHint')
  return (
    <Tooltip label={hint}>
      <span className="inline-flex" aria-label={hint}>
        <Folder className="w-2.5 h-2.5 text-muted-foreground/55" strokeWidth={1.75} aria-hidden />
      </span>
    </Tooltip>
  )
}

export default function TagEditor({ docId, tags, onChange }: TagEditorProps) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

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

  const handleAdd = async (tag: string) => {
    if (!tag || tags.includes(tag)) return
    await persist([...tags, tag])
  }

  const handleRemove = async (tag: string) => {
    const next = tags.filter((t) => t !== tag)
    await persist(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <TagIcon className="w-3.5 h-3.5 text-muted-foreground/50 mr-0.5" strokeWidth={1.75} />
      {tags.map((tag, i) => (
        <span
          key={tag}
          className="group/chip inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs bg-muted/60 hover:bg-muted text-foreground/85 hover:text-foreground transition-colors"
        >
          {i === 0 && <ArchiveFolderCue />}
          <span className="font-mono">{tag}</span>
          <button
            type="button"
            onClick={() => handleRemove(tag)}
            disabled={saving}
            className="w-4 h-4 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive hover:bg-background/60 transition-colors disabled:opacity-40"
            aria-label={t('tagEditor.removeTag', { tag })}
          >
            <X className="w-3 h-3" strokeWidth={1.75} />
          </button>
        </span>
      ))}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={saving}
        aria-label={t('tagEditor.pickTag')}
        className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full border border-dashed border-border/70 hover:border-foreground/30 text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-40"
      >
        <Plus className="w-3 h-3" strokeWidth={1.75} />
        <span className="text-xs">{t('tagEditor.addTag')}</span>
        {saving && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/60" />}
      </button>
      {pickerOpen && (
        <TagPickerPopover
          anchorRef={triggerRef}
          existing={tags}
          onPick={(tag) => void handleAdd(tag)}
          onClose={() => setPickerOpen(false)}
          disabled={saving}
        />
      )}
    </div>
  )
}
