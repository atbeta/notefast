import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import SettingsPage from './routes/settings'
import SettingsAIPage from './routes/settings-ai'
import Layout from './components/Layout'

export default function App() {
  const location = useLocation()
  // 内容宽度策略：
  // - '/'           home/列表       56rem (5xl)
  // - '/new'        新建表单       42rem (prose)
  // - '/doc/:id'    doc 阅读/编辑   42rem (prose)
  // - '/settings*'  设置页         42rem (prose)
  const isHome = location.pathname === '/'
  const contentClassName = isHome ? 'max-w-5xl' : 'max-w-prose'

  return (
    <Layout contentClassName={contentClassName}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewDocPage />} />
        <Route path="/doc/:id" element={<DocPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/ai" element={<SettingsAIPage />} />
      </Routes>
    </Layout>
  )
}
