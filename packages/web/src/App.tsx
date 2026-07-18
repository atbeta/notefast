import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import SettingsPage from './routes/settings'
import SettingsAIPage from './routes/settings-ai'
import Layout from './components/Layout'

export default function App() {
  const location = useLocation()
  const wide = location.pathname === '/' || location.pathname === '/new' || location.pathname.startsWith('/doc/')
  const contentClassName = wide ? 'max-w-5xl' : 'max-w-prose'

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
