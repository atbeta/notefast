import { Routes, Route } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import SettingsPage from './routes/settings'
import SettingsAIPage from './routes/settings-ai'
import InboxPage from './routes/inbox'
import Layout from './components/Layout'
import { ToastProvider } from './components/ui'

export default function App() {
  // 宽度策略交给各页面自己处理，Layout 负责通用的全屏框架
  const contentClassName = 'w-full h-full'

  return (
    <ToastProvider>
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
