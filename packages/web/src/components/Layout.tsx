import { Link, useLocation } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 font-bold text-lg text-gray-900 hover:text-blue-600 transition-colors">
            <BookOpen className="w-5 h-5" />
            NoteFast
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              to="/"
              className={`hover:text-blue-600 transition-colors ${location.pathname === '/' ? 'text-blue-600 font-medium' : 'text-gray-500'}`}
            >
              文档
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto px-4 py-6 w-full">
        {children}
      </main>
    </div>
  )
}
