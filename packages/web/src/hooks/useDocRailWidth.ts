import { useEffect, useState } from 'react'

/**
 * 文档页右栏宽度档位（普通 288px / 宽 400px——默认回归旧值 288，展开对齐 AI 聊天窗默认态 400）。
 * 折叠态（w-9）由 useDocRailCollapsed 管理；宽度档位仅在展开时生效，两者互不干扰。
 */

export type DocRailWidth = 'normal' | 'wide'

export const DOC_RAIL_WIDTH_KEY = 'nf_doc_rail_width'
const DOC_RAIL_WIDTH_EVENT = 'nf:doc-rail-width'

/** 档位 → 展开态实际宽度（px）。normal 保持历史 288（w-72），wide=400 对齐聊天窗默认宽度。 */
export const DOC_RAIL_WIDTH_PX: Record<DocRailWidth, number> = {
  normal: 288,
  wide: 400,
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
