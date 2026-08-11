import { useEffect, useState } from 'react'

/**
 * 文档页右栏宽度档位（普通 400px / 宽 600px——与 AI 聊天窗两档完全对齐）。
 * 折叠态（w-9）由 useDocRailCollapsed 管理；宽度档位仅在展开时生效，两者互不干扰。
 */

export type DocRailWidth = 'normal' | 'wide'

export const DOC_RAIL_WIDTH_KEY = 'nf_doc_rail_width'
const DOC_RAIL_WIDTH_EVENT = 'nf:doc-rail-width'

/** 档位 → 展开态实际宽度（px）。与 AIChatPanel 的 md:w-[400px] / md:w-[600px] 一致。 */
export const DOC_RAIL_WIDTH_PX: Record<DocRailWidth, number> = {
  normal: 400,
  wide: 600,
}

export function readDocRailWidth(): DocRailWidth {
  try {
    return localStorage.getItem(DOC_RAIL_WIDTH_KEY) === 'wide' ? 'wide' : 'normal'
  } catch {
    return 'normal'
  }
}

export function writeDocRailWidth(width: DocRailWidth): void {
  try {
    localStorage.setItem(DOC_RAIL_WIDTH_KEY, width)
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(new Event(DOC_RAIL_WIDTH_EVENT))
}

/** 订阅文档页右栏宽度档位（同页 custom event + 跨标签 storage） */
export function useDocRailWidth(): DocRailWidth {
  const [width, setWidth] = useState(readDocRailWidth)
  useEffect(() => {
    const sync = () => setWidth(readDocRailWidth())
    window.addEventListener(DOC_RAIL_WIDTH_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(DOC_RAIL_WIDTH_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return width
}
