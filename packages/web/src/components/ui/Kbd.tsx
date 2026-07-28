import type { ReactNode } from 'react'

/** 快捷键键帽：统一样式 + inset 底影模拟按键厚度（inset 不占布局，避免行高抖动） */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center whitespace-nowrap rounded border border-border bg-card px-1.5 py-[3px] font-mono text-[10.5px] leading-none text-muted-foreground/80 shadow-[inset_0_-1px_0_rgb(var(--border))] ${className}`}
    >
      {children}
    </kbd>
  )
}
