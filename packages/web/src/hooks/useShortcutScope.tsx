import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ShortcutPage } from '../lib/shortcutCatalog'

type ShortcutScopeCtl = {
  page: ShortcutPage
  setPage: (page: ShortcutPage) => void
}

const ShortcutScopeContext = createContext<ShortcutScopeCtl>({
  page: 'none',
  setPage: () => {},
})

export function ShortcutScopeProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<ShortcutPage>('none')
  const value = useMemo(() => ({ page, setPage }), [page])
  return (
    <ShortcutScopeContext.Provider value={value}>
      {children}
    </ShortcutScopeContext.Provider>
  )
}

export function useShortcutScope(): ShortcutScopeCtl {
  return useContext(ShortcutScopeContext)
}

/** 文档页挂载期间登记本页快捷键范围，离开时清掉 */
export function useRegisterShortcutPage(page: ShortcutPage): void {
  const { setPage } = useShortcutScope()
  useEffect(() => {
    setPage(page)
    return () => setPage('none')
  }, [page, setPage])
}
