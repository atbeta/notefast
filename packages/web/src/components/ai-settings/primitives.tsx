import type { ReactNode } from 'react'

/** 设置分组卡片：图标 + 标题 + 说明 + 内容插槽 */
export function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode
  title: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-3 border-b border-border bg-background/50">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          <span>{title}</span>
        </div>
        {hint && <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

/** AutoLink 自动应用策略的单选卡片（role=radio） */
export function AutoLinkOption({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean
  title: string
  description: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3.5 py-3 transition-colors ${
        selected
          ? 'border-foreground/25 bg-foreground/[0.04]'
          : 'border-border hover:bg-accent/40'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`mt-0.5 inline-grid h-4 w-4 shrink-0 place-content-center rounded-full border-[1.5px] ${
            selected ? 'border-[rgb(var(--ink))]' : 'border-[rgb(var(--border))]'
          }`}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-[rgb(var(--ink))]" />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</span>
        </span>
      </div>
    </button>
  )
}

/** 顶部状态条里的能力徽标（Chat / Embedding / Reranker 可用性点） */
export function CapabilityBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${
        ok ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
      />
      {label}
    </span>
  )
}
