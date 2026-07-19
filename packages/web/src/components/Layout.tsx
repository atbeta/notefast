import { useState, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Menu, MessageSquareText } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import AIChatPanel from './AIChatPanel'

export default function Layout({ children, contentClassName }: { children: ReactNode; contentClassName?: string }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  
  const navigate = useNavigate()
  const location = useLocation()
  
  // 提取当前文档ID作为 AI 上下文
  const docIdMatch = location.pathname.match(/\/doc\/([^/]+)/)
  const currentDocId = docIdMatch ? docIdMatch[1] : undefined

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

  const openAiChat = useCallback(() => setAiChatOpen(true), [])
  const closeMobile = useCallback(() => setMobileOpen(false), [])

  // 全局快捷键：⌘K / Ctrl+K, ⌘N / Ctrl+N, ⌘\ / Ctrl+\, ⌘J / Ctrl+J (打开 AI Chat)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAiChatOpen((v) => !v)
      } else if (mod && e.key.toLowerCase() === 'n' && !paletteOpen) {
        e.preventDefault()
        navigate('/new')
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleSidebar, navigate, paletteOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-background relative">
      {/* 桌面侧边栏 */}
      <div className={`hidden md:block transition-all duration-300 z-20 relative ${sidebarCollapsed ? 'w-14' : 'w-60'}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
          onOpenPalette={openPalette}
          onOpenChat={openAiChat}
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
              onOpenChat={openAiChat}
              onNavigate={closeMobile}
            />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative z-10">
        <div className="md:hidden flex items-center h-12 px-4 border-b border-border bg-card gap-3 shrink-0">
          <button onClick={toggleMobileSidebar} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-foreground transition-colors" aria-label="打开菜单">
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-semibold text-sm">NoteFast</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setAiChatOpen(!aiChatOpen)}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              aria-label="聊天 / 知识库问答"
            >
              <MessageSquareText className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={openPalette}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              aria-label="搜索"
            >
              <SearchIcon />
            </button>
          </div>
        </div>
        <main className={`flex-1 overflow-y-auto transition-all duration-300 ${aiChatOpen ? 'md:pr-[400px]' : ''}`}>
          <div className={(contentClassName ?? 'max-w-prose') + ' mx-auto px-6 py-8'}>
            {children}
          </div>
        </main>
      </div>

      {/* 桌面端 chat 入口 —— 已移入顶栏，对应 ⌘J 开 / 关 */}
      {/* 此处保留位置供未来全局 toast 等使用 */}

      {/* AI Chat 面板 */}
      <AIChatPanel 
        isOpen={aiChatOpen} 
        onClose={() => setAiChatOpen(false)} 
        contextDocId={currentDocId}
      />

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