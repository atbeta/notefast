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
import { install as installErrorReporter } from './lib/errorReporter'
import { cycleDocFontSize, resetDocFontSize } from './hooks/useDocFontSize'
import ErrorBoundary from './components/ErrorBoundary'

// 原生壳适配（右键菜单屏蔽等）：浏览器形态内部自动跳过
initNativeShell()
// 全局禁用输入历史记忆（密码框豁免）——桌面壳里浏览器式历史下拉很违和
initNoAutofill()
// 客户端错误埋点（componentDidCatch / window.onerror / unhandledrejection）→ POST /api/v1/client-errors
installErrorReporter()

// 文档正文字号（demo 放大）— 在 :root 上写 CSS 变量，.reading-prose 与 CodeMirror 都
// 引用。App 树里挂 DocFontSizeApplier 一次即可，本文件只装键盘快捷键。
// 全局 Ctrl+= / Ctrl+- / Ctrl+0 快捷键：随时能调（不依赖控件可见）
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    // 文本输入区不抢 Ctrl+=（用户可能在调字号，但这是浏览器原生行为；让浏览器自己处理）
    if (e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      cycleDocFontSize(1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      cycleDocFontSize(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      resetDocFontSize()
    }
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 顶层错误边界：组件抛错不再白屏，展示具体错误 + 重试入口 */}
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)
