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
  /** 嵌入 h-14 全局顶栏：去掉自身底边框与下 padding，与侧边栏顶栏贯通 */
  embedded?: boolean
}

export default function SubNavTabs({ tabs, activeKey, onChange, trailing, embedded }: SubNavTabsProps) {
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
    <div className={`relative flex justify-between ${embedded ? 'h-full items-center' : 'items-end border-b border-border'}`}>
      <div ref={containerRef} className="relative flex items-center gap-6 h-full">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey
          return (
            <button
              key={tab.key}
              ref={(el) => { itemRefs.current[tab.key] = el }}
              onClick={() => onChange(tab.key)}
              className={
                'relative h-full flex items-center text-base transition-colors ' +
                (embedded ? '' : 'pb-3 ') +
                (isActive
                  ? 'font-semibold text-foreground'
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
      {trailing && <div className={embedded ? '' : 'pb-3'}>{trailing}</div>}
    </div>
  )
}
