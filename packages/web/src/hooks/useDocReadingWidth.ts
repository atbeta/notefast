import { useEffect, useState } from 'react'

/**
 * 文档阅读列宽度档位（普通 46rem=736px 保持最佳行宽 / 加宽 64rem=1024px 图表友好）。
 * 仅影响阅读列宽度（--reading-max-w），与缩放（zoom）正交——加宽不放大，放大不加宽。
 */

export type DocReadingWidth = 'normal' | 'wide'

export const DOC_READING_WIDTH_KEY = 'nf_doc_reading_width'
const DOC_READING_WIDTH_EVENT = 'nf:doc-reading-width'

/** 档位 → 阅读列 max-width（rem）。normal=最佳实践区间内；wide=图表/表格友好。 */
export const DOC_READING_WIDTH_REM: Record<DocReadingWidth, number> = {
  normal: 46,
  wide: 64,
}

export function readDocReadingWidth(): DocReadingWidth {
  try {
    return localStorage.getItem(DOC_READING_WIDTH_KEY) === 'wide' ? 'wide' : 'normal'
  } catch {
    return 'normal'
  }
}

export function writeDocReadingWidth(width: DocReadingWidth): void {
  try {
    localStorage.setItem(DOC_READING_WIDTH_KEY, width)
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(new Event(DOC_READING_WIDTH_EVENT))
}

/** 订阅阅读列宽度档位（同页 custom event + 跨标签 storage） */
export function useDocReadingWidth(): DocReadingWidth {
  const [width, setWidth] = useState(readDocReadingWidth)
  useEffect(() => {
    const sync = () => setWidth(readDocReadingWidth())
    window.addEventListener(DOC_READING_WIDTH_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(DOC_READING_WIDTH_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return width
}
