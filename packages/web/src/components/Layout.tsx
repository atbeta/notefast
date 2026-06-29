import { useState, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Menu, X } from 'lucide-react'
import Sidebar from './Sidebar'
import { useNavigate } from 'react-router-dom'

export default function Layout({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigate = useNavigate()

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev)
  }, [])

  const toggleMobileSidebar = useCallback(() => {
    setMobileOpen((prev) => !prev)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        navigate('/new')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleSidebar, navigate])

  return (
    <div className="flex h-screen overflow-hidden bg-warm-50 dark:bg-warm-900">
      <div className={`fixed inset-y-0 left-0 z-50 transition-transform duration-300 md:relative md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={mobileOpen ? toggleMobileSidebar : toggleSidebar} />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/30 z-40 md:hidden" onClick={toggleMobileSidebar} />
      )}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="md:hidden flex items-center h-12 px-4 border-b border-warm-200 dark:border-warm-700 bg-white dark:bg-warm-800">
          <button onClick={toggleMobileSidebar} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-warm-100 dark:hover:bg-warm-700 text-warm-500 dark:text-warm-300 transition-colors">
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-prose mx-auto px-6 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}