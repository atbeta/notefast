import type { ReactNode } from 'react'

export interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

/** 列表/面板空态：44px 图标块 + 标题 + 描述 + 可选行动 */
export function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`px-3 py-14 flex flex-col items-center text-center ${className}`}>
      <div className="empty-icon-tile">{icon}</div>
      <h3 className="text-[15px] font-medium text-foreground mb-1.5 tracking-[-0.005em]">{title}</h3>
      {description != null && description !== '' && (
        <div className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
          {description}
        </div>
      )}
      {action}
    </div>
  )
}
