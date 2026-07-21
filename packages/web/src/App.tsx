import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import SettingsPage from './routes/settings'
import SettingsAIPage from './routes/settings-ai'
import InboxPage from './routes/inbox'
import Layout from './components/Layout'
import AuthPrompt from './components/AuthPrompt'
import { ToastProvider } from './components/ui'
import { getStoredPassword } from './hooks/useAPI'

interface AuthMode {
  passwordRequired: boolean
  tokenRequired: boolean
}

export default function App() {
  const contentClassName = 'w-full h-full'
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)

  // 启动探测：服务端是否需要密码
  useEffect(() => {
    fetch('/api/v1/auth/mode')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((mode: AuthMode) => setAuthMode(mode))
      .catch(() => setAuthMode({ passwordRequired: false, tokenRequired: false }))
  }, [])

  // 探测未完成 → 不渲染内容（避免短暂闪现未鉴权页面）
  // 探测完成 + 需要密码 + 本地没有可用密码（持久化/会话级均无）→ 显示登录弹框
  const showAuthPrompt = authMode?.passwordRequired === true && !getStoredPassword()

  return (
    <ToastProvider>
      {showAuthPrompt && <AuthPrompt />}
      <Layout contentClassName={contentClassName}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/new" element={<NewDocPage />} />
          <Route path="/doc/:id" element={<DocPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/ai" element={<SettingsAIPage />} />
        </Routes>
      </Layout>
    </ToastProvider>
  )
}