import type { ReactNode } from 'react'
import { usePlatform } from '../../hooks/usePlatform'
import { formatShortcutParts, shortcutLabel as formatShortcutLabel } from '../../lib/shortcutDisplay'

export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center whitespace-nowrap rounded-md border border-border bg-card px-1.5 py-[3px] font-mono text-2xs leading-none text-muted-foreground/80 shadow-[inset_0_-1px_0_rgb(var(--border))] ${className}`}
    >
      {children}
    </kbd>
  )
}

/** 组合键展示：自动检测平台，Mac 用符号、非 Mac 用文字 + 分隔符 */
export function ShortcutKeys({ keys, className = '' }: { keys: string[]; className?: string }) {
  const { isMac } = usePlatform()
  const resolved = formatShortcutParts(keys, isMac)

  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {resolved.map((key, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="text-muted-foreground/50 select-none">+</span>}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  )
}

/** 单个修饰键快捷文本（不上 Kbd 壳），如 Tooltip label 中用 */
export function shortcutLabel(keys: string[]): string {
  return formatShortcutLabel(keys)
}
