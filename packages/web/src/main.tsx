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
import { cycleDemoZoom, resetDemoZoom, tryExitDemoOnEscape } from './hooks/useDemoMode'
import ErrorBoundary from './components/ErrorBoundary'

// 原生壳适配（右键菜单屏蔽等）：浏览器形态内部自动跳过
initNativeShell()
// 全局禁用输入历史记忆（密码框豁免）——桌面壳里浏览器式历史下拉很违和
initNoAutofill()
// 客户端错误埋点（componentDidCatch / window.onerror / unhandledrejection）→ POST /api/v1/client-errors
installErrorReporter()

// 缩放 / 演示快捷键（临时场景不持久化）
// - Ctrl+=/-/0：阅读态随时能调缩放（输入区不抢）
// - Esc：演示中退出（输入区不抢，留给标题/对话框；已 preventDefault 的 Esc 也不抢）
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const inEditable =
      e.target instanceof HTMLElement &&
      (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)

    if (e.key === 'Escape') {
      if (inEditable || e.defaultPrevented) return
      // 对话框 / 菜单优先吃掉 Esc，勿连带退出演示
      if (document.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]')) return
      if (tryExitDemoOnEscape()) e.preventDefault()
      return
    }

    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    if (inEditable) return
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      cycleDemoZoom(1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      cycleDemoZoom(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      resetDemoZoom()
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
