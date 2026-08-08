import { useEffect, useState } from 'react'

/** 与文档页右栏折叠状态共用的 localStorage key */
export const DOC_RAIL_COLLAPSED_KEY = 'nf_doc_rail_collapsed'
const DOC_RAIL_COLLAPSED_EVENT = 'nf:doc-rail-collapsed'

export function readDocRailCollapsed(): boolean {
  try {
    return localStorage.getItem(DOC_RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeDocRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(DOC_RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(new Event(DOC_RAIL_COLLAPSED_EVENT))
}

/** 订阅文档页右栏折叠态（同页 custom event + 跨标签 storage） */
export function useDocRailCollapsed(): boolean {
  const [collapsed, setCollapsed] = useState(readDocRailCollapsed)
  useEffect(() => {
    const sync = () => setCollapsed(readDocRailCollapsed())
    window.addEventListener(DOC_RAIL_COLLAPSED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(DOC_RAIL_COLLAPSED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return collapsed
}
