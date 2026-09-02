/**
 * 全局禁用输入历史记忆
 *
 * 原因：桌面壳（Tauri / WKWebView）里保留浏览器风格的输入历史很违和
 * （标题、搜索、设置项都会弹历史下拉）。Web 形态同样禁用，行为一致。
 *
 * 引擎差异（关键）：
 * - Blink（Chrome / Edge / WebView2）常忽略 autocomplete="off"，需非标准
 *   token（"nope"）才能挡住「以前的输入」下拉。
 * - WebKit（Safari / WKWebView）恰好相反：autofill 解析把任何非 "off" 值
 *   都当作 On（HTMLInputElement::attributeChanged），"nope" 会被当成开启
 *   → 仍弹历史下拉。必须用标准 "off"。
 * - Firefox 尊重 "off"。
 *
 * 豁免：type="password"，以及显式 current-password / new-password / username
 * （AuthPrompt 密码管理器需要保留）。
 */

/** 按渲染引擎选择能真正关掉历史建议的 autocomplete 值 */
export function resolveEngineToken(ua?: string): string {
  const agent = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  // Blink 忽略 "off"；WebKit 忽略非 "off"。其余引擎（Firefox 等）尊重 "off"
  if (/Chrome|Chromium|Edg\//.test(agent)) return 'nope'
  return 'off'
}

/** 当前引擎下应写入的 autocomplete 值 */
export const NO_AUTOFILL_TOKEN = resolveEngineToken()

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

/** 给单个控件打上禁用标记（已豁免则不动）。tagName 判定（不用 instanceof，便于测试与跨 realm） */
export function applyNoAutofill(el: HTMLInputElement | HTMLTextAreaElement | HTMLFormElement): void {
  if (el.tagName === 'FORM') {
    const next = resolveNoAutofillToken(null, el.getAttribute('autocomplete'))
    if (next && el.getAttribute('autocomplete') !== next) el.setAttribute('autocomplete', next)
    return
  }
  const type = el.getAttribute('type')
  const next = resolveNoAutofillToken(type, el.getAttribute('autocomplete'))
  if (next && el.getAttribute('autocomplete') !== next) el.setAttribute('autocomplete', next)
}

function disableIn(root: ParentNode): void {
  // MutationObserver 的 addedNodes 可能是控件本体（{editing && <input/>} 内联重命名、
  // 条件渲染的裸输入框等）：querySelectorAll 不匹配 root 自身，本体必须单独处理，
  // 否则这类输入框永远打不上标记、浏览器照样弹历史下拉
  if (root instanceof Element) {
    const tag = root.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'FORM') {
      applyNoAutofill(root as HTMLInputElement)
    }
  }
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
