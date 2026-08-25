import { useEffect, useState } from 'react'

/**
 * 阅读/分享代码块是否折行。默认横向滚动；与分块无关，只改显示。
 */

export const CODE_WRAP_KEY = 'nf_code_wrap'
const CODE_WRAP_EVENT = 'nf:code-wrap'

export function readCodeWrap(): boolean {
  try {
    return localStorage.getItem(CODE_WRAP_KEY) === '1'
  } catch {
    return false
  }
}

export function writeCodeWrap(wrap: boolean): void {
  try {
    localStorage.setItem(CODE_WRAP_KEY, wrap ? '1' : '0')
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(new Event(CODE_WRAP_EVENT))
}

export function useCodeWrap(): boolean {
  const [wrap, setWrap] = useState(readCodeWrap)
  useEffect(() => {
    const sync = () => setWrap(readCodeWrap())
    window.addEventListener(CODE_WRAP_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CODE_WRAP_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return wrap
}
