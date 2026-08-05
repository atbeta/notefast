import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './i18n'
// 自托管可变字体（npm 打包，无外部 CDN；source-serif-4 走 opsz 变体保留视觉字号轴）
import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { initNativeShell } from './lib/nativeShell'
import { initNoAutofill } from './lib/noAutofill'

// 原生壳适配（右键菜单屏蔽等）：浏览器形态内部自动跳过
initNativeShell()
// 全局禁用输入历史记忆（密码框豁免）——桌面壳里浏览器式历史下拉很违和
initNoAutofill()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
