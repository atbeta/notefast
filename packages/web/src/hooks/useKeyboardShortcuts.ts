import { useEffect, type RefObject } from 'react'

export interface ShortcutDef {
  key: string
  ctrlOrCmd?: boolean
  shift?: boolean
  enabled?: () => boolean
  action: (e: KeyboardEvent) => void
  /** 限定仅在指定元素获得焦点时响应 */
  targetRef?: RefObject<HTMLElement | null>
}

export function useKeyboardShortcuts(
  shortcuts: ShortcutDef[],
  deps: unknown[],
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        const mod = e.metaKey || e.ctrlKey
        if (s.ctrlOrCmd !== undefined && s.ctrlOrCmd !== mod) continue
        if (s.shift !== undefined && s.shift !== e.shiftKey) continue
        if (s.key.toLowerCase() !== e.key.toLowerCase()) continue
        if (s.enabled?.() === false) continue
        if (s.targetRef && document.activeElement !== s.targetRef.current) continue
        e.preventDefault()
        s.action(e)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
