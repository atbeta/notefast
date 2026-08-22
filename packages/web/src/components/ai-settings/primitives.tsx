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

/** 顶部状态条里的能力徽标（Chat / Embedding / Reranker 可用性点） */
export function CapabilityBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md ${
        ok ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-success' : 'bg-muted-foreground/50'}`}
      />
      {label}
    </span>
  )
}
