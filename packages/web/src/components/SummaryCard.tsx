import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

interface SummaryCardProps {
  icon: ReactNode
  title: ReactNode
  badge?: ReactNode
  description?: ReactNode
  to: string
}

/** 设置中心 dashboard 上的入口卡：左侧图标+标题+描述+状态角标，右侧 → */
export default function SummaryCard({ icon, title, badge, description, to }: SummaryCardProps) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-4 rounded-lg border border-border bg-card shadow-card px-5 py-4 hover:bg-accent/60 transition-colors"
    >
      <div className="shrink-0 w-9 h-9 rounded-lg bg-accent/60 text-muted-foreground flex items-center justify-center group-hover:text-foreground transition-colors">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-foreground">{title}</span>
          {badge}
        </div>
        {description && <p className="text-[12px] text-muted-foreground mt-1 leading-snug">{description}</p>}
      </div>
      <ArrowRight className="w-4 h-4 text-muted-foreground/60 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" strokeWidth={1.75} />
    </Link>
  )
}
