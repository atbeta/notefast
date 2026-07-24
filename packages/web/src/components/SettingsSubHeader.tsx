import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** 子页顶部面包屑：设置 / {section} */
export default function SettingsSubHeader({ section }: { section: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80">
      <Link to="/settings" className="hover:text-foreground transition-colors">设置</Link>
      <span>/</span>
      <span className="text-muted-foreground">{section}</span>
    </div>
  )
}
