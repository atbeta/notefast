import { Routes, Route } from 'react-router-dom'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import Layout from './components/Layout'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewDocPage />} />
        <Route path="/doc/:id" element={<DocPage />} />
      </Routes>
    </Layout>
  )
}
