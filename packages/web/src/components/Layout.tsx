import { useState, useCallback, useEffect, createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, Search, Sparkles } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useRecordNavHistory } from '../hooks/useNavHistory'
import { navHistorySnapshot } from '../lib/navHistory'
import { isTauriShell } from '../hooks/useShell'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import AIChatPanel from './AIChatPanel'
import GlobalSyncStatus from './GlobalSyncStatus'
import TitleBar from './TitleBar'
import { ServerOfflineBanner } from './ServerHealthBar'
import { useTheme } from '../hooks/useTheme'
import { prefetchTagCatalog } from '../hooks/useTagCatalog'
import { ASK_AI_EVENT } from '../lib/askAi'
import { useDemoMode } from '../hooks/useDemoMode'
import { isWindowZoomDoubleClickTarget, nativeToggleWindowZoom } from '../lib/nativeWindow'
import { installNativeNavigate } from '../lib/nativeNavigate'

/** AI 聊天面板控制 — 开合状态 + toggle（内容顶栏常驻入口 / 文档右栏避让共用） */
type AiChatCtl = { open: boolean; toggle: () => void }
const AiChatCtlContext = createContext<AiChatCtl>({ open: false, toggle: () => {} })
export const useAiChatCtl = () => useContext(AiChatCtlContext)
export const useAiChatOpen = () => useContext(AiChatCtlContext).open

export default function Layout({ children, contentClassName }: { children: ReactNode; contentClassName?: string }) {
  const { t } = useTranslation()
  /** 演示模式：隐藏左侧全局导航（doc.tsx 另有右侧 rail 折叠 + 正文 zoom） */
  const demo = useDemoMode()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 深链 palette_search 的预填 query（关闭面板时清空，下次 ⌘K 回到空查询） */
  const [palettePrefill, setPalettePrefill] = useState('')
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiChatExpanded, setAiChatExpanded] = useState(false)

  const toggleAiChatExpand = useCallback(() => setAiChatExpanded((v) => !v), [])
  
  const navigate = useNavigate()
  const location = useLocation()
  useRecordNavHistory()

  // 原生壳双击打开：走客户端路由，避免整页重载
  useEffect(() => installNativeNavigate((path) => { navigate(path) }), [navigate])
  
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

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPalettePrefill('')
  }, [])

  const closeAiChat = useCallback(() => setAiChatOpen(false), [])
  const toggleAiChat = useCallback(() => setAiChatOpen((v) => !v), [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])

  const { resolvedTheme, setTheme } = useTheme()

  // 进壳即拉标签云：与文档列表并行，避免回到「所有文档」时 chip 行后到把列表顶下去
  useEffect(() => {
    prefetchTagCatalog()
  }, [])

  // 阅读态块菜单「问 AI 关于这一段」→ 打开聊天面板；草稿预填由 AIChatPanel 自行监听
  useEffect(() => {
    const open = () => setAiChatOpen(true)
    window.addEventListener(ASK_AI_EVENT, open)
    return () => window.removeEventListener(ASK_AI_EVENT, open)
  }, [])

  // macOS 壳深链 notefast://search?q=xxx → /?palette_search=xxx：
  // 打开命令面板并预填 query，消费后清掉参数防刷新复触发（URL 方案无事件时序问题）
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const q = params.get('palette_search')
    if (!q) return
    setPalettePrefill(q)
    setPaletteOpen(true)
    params.delete('palette_search')
    const search = params.toString()
    navigate({ search: search ? `?${search}` : '' }, { replace: true })
  }, [location.search, navigate])

  // 全局快捷键：⌘K / Ctrl+K, ⌘N / Ctrl+N, ⌘\ / Ctrl+\, ⌘J / Ctrl+J, ⌘⇧D / Ctrl+Shift+D
  // capture 阶段拦截，在浏览器默认行为之前处理（⌘N 可能被浏览器截为新窗口）
  useEffect(() => {
    const isEditing = (el: Element | null) => {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (el.getAttribute('contenteditable') === 'true') return true
      return false
    }
    const handler = (e: KeyboardEvent) => {
      // IME 合成中：用户正在用拼音/日文输入法候选，Cmd+K 之类绝不该插足——否则
      // 候选确认时带上 “k”，还会一路触发命令面板
      if (e.isComposing || e.keyCode === 229) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      // ⌘K 在面板已开时优先关闭——即使焦点在面板输入框内
      // （isEditing 守卫只保护「未开时不在输入态打断」；
      //   ⌘J 在编辑器/输入框无任何绑定冲突，见下方分支，不做守卫）
      if (mod && key === 'k') {
        if (paletteOpen) { e.preventDefault(); setPaletteOpen(false); return }
        if (isEditing(document.activeElement)) return
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (mod && key === 'j') {
        // ⌘J 是 AI 聊天全局入口，一律接管开关：编辑器（Mod-Shift-k 插入链接，无 Mod-J
        // 绑定）与输入框都没有占用它。守卫若拦下又不 preventDefault，Ctrl+J 会放行
        // 给浏览器默认行为（打开下载）。例外：命令面板打开时不抢（模态上下文优先）。
        if (paletteOpen) return
        e.preventDefault()
        setAiChatOpen(!aiChatOpen)
        return
      }
      // ⌘⇧D 主题切换：面板打开时即使输入框聚焦也生效（面板里展示了该快捷键提示）
      if (mod && e.shiftKey && key === 'd') {
        if (paletteOpen || !isEditing(document.activeElement)) {
          e.preventDefault()
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
        }
        return
      }
      if (isEditing(document.activeElement)) return
      // Tauri 壳没有浏览器后退；macOS 壳走菜单 ⌘[，浏览器自带后退，都不在这里抢
      if (isTauriShell() && mod && !e.shiftKey && e.key === '[') {
        if (navHistorySnapshot().canBack) {
          e.preventDefault()
          navigate(-1)
        }
        return
      }
      if (isTauriShell() && mod && !e.shiftKey && e.key === ']') {
        if (navHistorySnapshot().canForward) {
          e.preventDefault()
          navigate(1)
        }
        return
      }
      if (mod && key === 'n' && !paletteOpen) {
        e.preventDefault()
        navigate('/new')
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
    // aiChatOpen 必须在 deps：handler 闭包读它做开关判断，漏了会 stale closure——
    // Ctrl+J 永远用旧值（打开后再次按仍是「开」→ 无法连续切换）
  }, [toggleSidebar, navigate, paletteOpen, aiChatOpen, resolvedTheme, setTheme])

  return (
    // 根容器 pt/pb 用 env() 吸收刘海/Home 指示条安全区（非 standalone/无刘海环境恒为 0，不影响现有布局）
    <div className="flex flex-col h-screen overflow-hidden bg-background relative w-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] print:h-auto print:overflow-visible">
      {/* 原生壳自绘标题栏（仅 Tauri 壳渲染；macOS 壳走系统标题栏，浏览器不渲染）。
          演示模式隐藏：避免用户把窗口关闭按钮误当「退出演示」 */}
      {!demo.active && <div className="print:hidden"><TitleBar /></div>}
      <div className="flex flex-1 min-h-0 relative">
        <div className="print:hidden">
        <GlobalSyncStatus />
        </div>
        {/* 桌面侧边栏 — 演示模式隐藏（正文最大化，退出后恢复） */}
        {!demo.active && (
        <div className={`hidden md:block transition-[width] duration-slow z-header relative print:hidden ${sidebarCollapsed ? 'w-14' : 'w-60'}`}>
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            onOpenPalette={openPalette}
          />
        </div>
        )}

        {/* 移动端 drawer — 演示模式不提供 */}
        {mobileOpen && !demo.active && (
          <div className="md:hidden fixed inset-0 z-sheet flex">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={closeMobile} />
            <div className="relative w-64 h-full bg-background shadow-floating animate-fade-in pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
              <Sidebar
                collapsed={false}
                onToggle={closeMobile}
                onOpenPalette={openPalette}
                onNavigate={closeMobile}
              />
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative z-sticky">
          <div
            className="md:hidden flex items-center h-12 px-4 border-b border-border bg-card gap-3 shrink-0 print:hidden"
            data-drag-region
            onDoubleClick={(e) => {
              if (!isWindowZoomDoubleClickTarget(e.target)) return
              nativeToggleWindowZoom()
            }}
          >
            <button onClick={toggleMobileSidebar} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-foreground transition-colors" aria-label={t('layout.openMenu')}>
              <Menu className="w-5 h-5" />
            </button>
            <span className="font-semibold text-sm">NoteFast</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setAiChatOpen(!aiChatOpen)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('layout.openAiChat')}
              >
                <Sparkles className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={openPalette}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('layout.search')}
              >
                <Search className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <main
            className={`flex-1 flex flex-col min-h-0 relative transition-[padding] duration-300 ${aiChatOpen ? (aiChatExpanded ? 'md:pr-[600px]' : 'md:pr-[400px]') : ''}`}
          >
            {/* 服务不可达总览条：探测成功会自动消失，无需手动清除 */}
            <ServerOfflineBanner />
            {/* 统一滚动容器：文档页内部自管滚动（h-full 正好一屏），其余页面由此容器滚动 */}
            <div className={`${contentClassName ?? 'w-full h-full'} flex flex-col overflow-y-auto print:overflow-visible print:h-auto`}>
              <AiChatCtlContext.Provider value={{ open: aiChatOpen, toggle: toggleAiChat }}>
                {children}
              </AiChatCtlContext.Provider>
            </div>
          </main>
        </div>

        {/* AI Chat 面板 */}
        <div className="print:hidden">
        <AIChatPanel
          isOpen={aiChatOpen}
          onClose={closeAiChat}
          contextDocId={currentDocId}
          expanded={aiChatExpanded}
          onToggleExpand={toggleAiChatExpand}
        />
        </div>

        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          onToggleAiChat={toggleAiChat}
          aiChatOpen={aiChatOpen}
          initialQuery={palettePrefill}
        />
      </div>
    </div>
  )
}
