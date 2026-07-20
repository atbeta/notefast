import { useState, useCallback, useEffect, createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { Menu, Sparkles, X } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import AIChatPanel from './AIChatPanel'

/** AI 聊天面板开关状态 — 页面（如文档页右栏）可据此避让空间 */
const AiChatOpenContext = createContext(false)
export const useAiChatOpen = () => useContext(AiChatOpenContext)

export default function Layout({ children, contentClassName }: { children: ReactNode; contentClassName?: string }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiChatExpanded, setAiChatExpanded] = useState(false)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform))
  }, [])

  const toggleAiChatExpand = useCallback(() => setAiChatExpanded((v) => !v), [])
  
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

  const closeAiChat = useCallback(() => setAiChatOpen(false), [])
  const toggleAiChat = useCallback(() => setAiChatOpen((v) => !v), [])

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
    <div className="flex h-screen overflow-hidden bg-background relative max-w-[1600px] w-full mx-auto">
      {/* 桌面侧边栏 */}
      <div className={`hidden md:block transition-all duration-300 z-20 relative ${sidebarCollapsed ? 'w-14' : 'w-60'}`}>
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
          <div className="relative w-64 h-full bg-background shadow-xl animate-fade-in">
            <Sidebar
              collapsed={false}
              onToggle={closeMobile}
              onOpenPalette={openPalette}
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
              <Sparkles className="w-4 h-4" strokeWidth={1.75} />
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
        <main className={`flex-1 flex flex-col min-h-0 relative transition-[padding] duration-300 ${aiChatOpen ? (aiChatExpanded ? 'md:pr-[600px]' : 'md:pr-[400px]') : ''}`}>
          {/* 统一滚动容器：文档页内部自管滚动（h-full 正好一屏），其余页面由此容器滚动 */}
          <div className={`${contentClassName ?? 'w-full h-full'} flex flex-col overflow-y-auto`}>
            <AiChatOpenContext.Provider value={aiChatOpen}>
              {children}
            </AiChatOpenContext.Provider>
          </div>
        </main>
      </div>

      {/* AI Chat 面板 */}
      <AIChatPanel
        isOpen={aiChatOpen}
        onClose={closeAiChat}
        contextDocId={currentDocId}
        expanded={aiChatExpanded}
        onToggleExpand={toggleAiChatExpand}
      />

      <CommandPalette open={paletteOpen} onClose={closePalette} />

      {/* AI 对话悬浮入口（FAB） —— 始终 z-50 在面板之上；面板展开时让位避免遮挡 */}
      <button
        type="button"
        onClick={toggleAiChat}
        aria-label={aiChatOpen ? '关闭 AI 对话' : '打开 AI 对话'}
        title={aiChatOpen ? `关闭 AI 对话（${isMac ? '⌘' : 'Ctrl'}J）` : `打开 AI 对话（${isMac ? '⌘' : 'Ctrl'}J）`}
        className={`fixed bottom-6 z-50 w-11 h-11 rounded-full bg-foreground text-background shadow-[var(--shadow-floating)] hover:scale-105 active:scale-95 transition-all duration-300 flex items-center justify-center ${
          aiChatOpen
            ? aiChatExpanded
              ? 'md:right-[616px]'
              : 'md:right-[416px]'
            : 'right-6'
        } right-6`}
      >
        {aiChatOpen ? (
          <X className="w-[18px] h-[18px]" strokeWidth={2} />
        ) : (
          <Sparkles className="w-[18px] h-[18px]" strokeWidth={1.75} />
        )}
      </button>
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