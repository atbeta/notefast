/**
 * 全局禁用输入历史记忆（autocomplete="off"）
 *
 * 原因：桌面壳（Tauri / WKWebView）里保留浏览器风格的输入历史很违和
 * （标题、搜索、设置项都会弹历史下拉）。Web 形态同样禁用，行为一致。
 *
 * 豁免：type="password" 的输入框——AuthPrompt 显式设了
 * autoComplete="current-password"，密码管理器需要保留。
 */

const SELECTOR = 'input:not([type="password"]), textarea'

function disableIn(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(SELECTOR).forEach((el) => {
    // 不覆盖显式设置（如 current-password）；缺省才补 off
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off')
  })
}

export function initNoAutofill(): void {
  disableIn(document)
  // 动态挂载的输入框（路由切换 / 弹窗）同样处理
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'childList') continue
      for (const node of m.addedNodes) {
        if (node instanceof Element) disableIn(node)
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })
}
