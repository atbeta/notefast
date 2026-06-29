import { useState, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'

export default function Layout({ children, contentClassName }: { children: ReactNode; contentClassName?: string }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const navigate = useNavigate()

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev)
  }, [])

  const toggleMobileSidebar = useCallback(() => {
    setMobileOpen((prev) => !prev)
  }, [])

  const openPalette = useCallback(() => {
    setPaletteOpen(true)
    setMobileOpen(false)
  }, [])

  const closePalette = useCallback(() => setPaletteOpen(false), [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])

  // 全局快捷键：⌘K / Ctrl+K, ⌘N / Ctrl+N, ⌘\ / Ctrl+\
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (mod && e.key.toLowerCase() === 'n' && !paletteOpen) {
        e.preventDefault()
        navigate('/new')
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'd' && paletteOpen) {
        // CommandPalette 内部自己处理
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleSidebar, navigate, paletteOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* 桌面侧边栏 */}
      <div className={`hidden md:block transition-all duration-300 ${sidebarCollapsed ? 'w-14' : 'w-60'}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
          onOpenPalette={openPalette}
        />
      </div>

      {/* 移动端 drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={closeMobile} />
          <div className="relative w-64 h-full bg-sidebar border-r border-sidebar-border shadow-xl animate-fade-in">
            <Sidebar
              collapsed={false}
              onToggle={closeMobile}
              onOpenPalette={openPalette}
              onNavigate={closeMobile}
            />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="md:hidden flex items-center h-12 px-4 border-b border-border bg-card gap-3">
          <button onClick={toggleMobileSidebar} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-foreground transition-colors" aria-label="打开菜单">
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-semibold text-sm">NoteFast</span>
          <button
            onClick={openPalette}
            className="ml-auto w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            aria-label="搜索"
          >
            <SearchIcon />
          </button>
        </div>
        <main className="flex-1 overflow-y-auto">
          <div className={(contentClassName ?? 'max-w-prose') + ' mx-auto px-6 py-8'}>
            {children}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  )
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}