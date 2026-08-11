/**
 * 全局禁用输入历史记忆
 *
 * 原因：桌面壳（Tauri / WKWebView）里保留浏览器风格的输入历史很违和
 * （标题、搜索、设置项都会弹历史下拉）。Web 形态同样禁用，行为一致。
 *
 * Blink（Chrome / Edge / 多数 WebView）常忽略 autocomplete="off"，改用
 * 非标准 token（"nope"）才能挡住「以前的输入」下拉；Firefox/Safari 对
 * 未知 token 也按关闭处理。
 *
 * 豁免：type="password"，以及显式 current-password / new-password / username
 * （AuthPrompt 密码管理器需要保留）。
 */

/** Blink 忽略 "off"；非标准值才能关掉历史建议 */
export const NO_AUTOFILL_TOKEN = 'nope'

const SELECTOR = 'input:not([type="password"]), textarea'
const KEEP_RE = /^(current-password|new-password|username)$/i

/**
 * 计算应写入的 autocomplete 值。
 * 返回 null = 不改动（豁免）。
 */
export function resolveNoAutofillToken(
  type: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  if ((type || '').toLowerCase() === 'password') return null
  if (existing && KEEP_RE.test(existing)) return null
  return NO_AUTOFILL_TOKEN
}

/** 给单个控件打上禁用标记（已豁免则不动） */
export function applyNoAutofill(el: HTMLInputElement | HTMLTextAreaElement | HTMLFormElement): void {
  if (el instanceof HTMLFormElement) {
    const next = resolveNoAutofillToken(null, el.getAttribute('autocomplete'))
    if (next && el.getAttribute('autocomplete') !== next) el.setAttribute('autocomplete', next)
    return
  }
  const type = el.getAttribute('type')
  const next = resolveNoAutofillToken(type, el.getAttribute('autocomplete'))
  if (next && el.getAttribute('autocomplete') !== next) el.setAttribute('autocomplete', next)
}

function disableIn(root: ParentNode): void {
  root.querySelectorAll<HTMLFormElement>('form').forEach(applyNoAutofill)
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(SELECTOR).forEach(applyNoAutofill)
}

export function initNoAutofill(): void {
  const start = () => {
    disableIn(document)
    // 动态挂载的输入框（路由切换 / 弹窗）同样处理
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== 'childList') continue
        for (const node of m.addedNodes) {
          if (node instanceof Element) disableIn(node)
          else if (node instanceof DocumentFragment) disableIn(node)
        }
      }
    })
    // documentElement 比 body 更稳（防极端时序）
    mo.observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}
