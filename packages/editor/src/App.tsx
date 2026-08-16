import { Routes, Route } from 'react-router-dom'
import OpenView from './routes/open'
import EditorView from './routes/editor'
import SettingsView from './routes/settings'

/** NoteFastEditor 应用骨架：M1 阶段三个占位路由，M2 起填充编辑器/预览/导入。 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<OpenView />} />
      <Route path="/editor" element={<EditorView />} />
      <Route path="/settings" element={<SettingsView />} />
    </Routes>
  )
}
