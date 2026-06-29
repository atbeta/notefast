import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface TabItem {
  key: string
  label: ReactNode
  badge?: ReactNode
}

interface SubNavTabsProps {
  tabs: TabItem[]
  activeKey: string
  onChange: (key: string) => void
  trailing?: ReactNode
}

export default function SubNavTabs({ tabs, activeKey, onChange, trailing }: SubNavTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useEffect(() => {
    const el = itemRefs.current[activeKey]
    const container = containerRef.current
    if (!el || !container) return
    const elRect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    setIndicator({ left: elRect.left - containerRect.left, width: elRect.width })
  }, [activeKey, tabs])

  useEffect(() => {
    const handler = () => {
      const el = itemRefs.current[activeKey]
      const container = containerRef.current
      if (!el || !container) return
      const elRect = el.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      setIndicator({ left: elRect.left - containerRect.left, width: elRect.width })
    }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [activeKey])

  return (
    <div className="relative flex items-end justify-between border-b border-border">
      <div ref={containerRef} className="relative flex items-center gap-6">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey
          return (
            <button
              key={tab.key}
              ref={(el) => { itemRefs.current[tab.key] = el }}
              onClick={() => onChange(tab.key)}
              className={
                'relative pb-3 text-sm transition-colors ' +
                (isActive
                  ? 'font-medium text-primary'
                  : 'font-medium text-muted-foreground hover:text-foreground')
              }
            >
              <span className="inline-flex items-center gap-2">
                {tab.label}
                {tab.badge}
              </span>
            </button>
          )
        })}
        <span
          className="subnav-underline"
          style={{ left: indicator.left, width: indicator.width }}
        />
      </div>
      {trailing && <div className="pb-3">{trailing}</div>}
    </div>
  )
}
