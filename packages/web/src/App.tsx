import { useEffect, useState } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import SettingsPage from './routes/settings'
import InboxPage from './routes/inbox'
import ArchivedPage from './routes/archived'
import TrashPage from './routes/trash'
import EntitiesPage from './routes/entities'
import GraphPage from './routes/graph'
import SharePage from './routes/share'
import Layout from './components/Layout'
import RouteTransition from './components/RouteTransition'
import AuthPrompt from './components/AuthPrompt'
import { ToastProvider } from './components/ui'
import { getStoredToken } from './hooks/useAPI'

interface AuthMode {
  passwordRequired: boolean
  tokenRequired: boolean
}

export default function App() {
  const contentClassName = 'w-full h-full'
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const location = useLocation()
  // 公开分享页：无侧栏、无登录弹框、不探测鉴权模式
  const isPublicShare = location.pathname.startsWith('/s/')

  // 启动探测：服务端是否需要密码
  useEffect(() => {
    if (isPublicShare) return
    fetch('/api/v1/auth/mode')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((mode: AuthMode) => setAuthMode(mode))
      .catch(() => setAuthMode({ passwordRequired: false, tokenRequired: false }))
  }, [isPublicShare])

  if (isPublicShare) {
    return (
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    )
  }

  // 探测未完成 → 不渲染内容（避免短暂闪现未鉴权页面）
  // 探测完成 + 需要密码 + 本地没有可用密码（持久化/会话级均无）→ 仅登录页，不挂 Layout（避免「已进入被遮挡」）
  const showAuthPrompt = authMode?.passwordRequired === true && !getStoredToken()

  if (showAuthPrompt) {
    return (
      <ToastProvider>
        <AuthPrompt />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <Layout contentClassName={contentClassName}>
        <RouteTransition>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/new" element={<NewDocPage />} />
            <Route path="/doc/:id" element={<DocPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/archived" element={<ArchivedPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/entities" element={<EntitiesPage />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
          </Routes>
        </RouteTransition>
      </Layout>
    </ToastProvider>
  )
}