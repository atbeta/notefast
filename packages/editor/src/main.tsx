import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
// 自托管可变字体（npm 打包，无外部 CDN；source-serif-4 走 opsz 变体保留视觉字号轴）
import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/jetbrains-mono'
import './index.css'

// NoteFastEditor 以壳层内嵌加载时用 HashRouter（file:// 与内嵌 WKWebView 下 history 路由会失效）
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
