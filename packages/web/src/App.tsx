import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import Layout from './components/Layout'

export default function App() {
  const location = useLocation()
  const wide = location.pathname === '/' || location.pathname === '/new'
  const contentClassName = wide ? 'max-w-4xl' : 'max-w-prose'

  return (
    <Layout contentClassName={contentClassName}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewDocPage />} />
        <Route path="/doc/:id" element={<DocPage />} />
      </Routes>
    </Layout>
  )
}
