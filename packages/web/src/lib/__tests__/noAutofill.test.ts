import { describe, expect, test } from 'bun:test'
import {
  NO_AUTOFILL_TOKEN,
  applyNoAutofill,
  resolveEngineToken,
  resolveNoAutofillToken,
} from '../noAutofill'

/** 无 DOM 环境的最小 Element 替身（applyNoAutofill 只依赖 tagName + get/setAttribute） */
function fakeEl(tagName: string, attrs: Record<string, string> = {}) {
  const el = {
    tagName,
    attrs: { ...attrs } as Record<string, string>,
    getAttribute(n: string): string | null {
      return el.attrs[n] ?? null
    },
    setAttribute(n: string, v: string): void {
      el.attrs[n] = v
    },
  }
  return el as unknown as HTMLInputElement & { attrs: Record<string, string> }
}

describe('resolveEngineToken', () => {
  test('Blink（Chrome/Edge/WebView2）→ 非标准 token', () => {
    expect(resolveEngineToken('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('nope')
    expect(resolveEngineToken('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0')).toBe('nope')
    expect(resolveEngineToken('Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/126.0.0.0 Safari/537.36')).toBe('nope')
  })

  test('WebKit（Safari/WKWebView）→ 标准 off（非 "off" 值会被当 On）', () => {
    expect(resolveEngineToken('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('off')
  })

  test('Firefox / 未知 UA → off', () => {
    expect(resolveEngineToken('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0')).toBe('off')
    expect(resolveEngineToken('')).toBe('off')
  })
})

describe('resolveNoAutofillToken', () => {
  test('普通文本框 → 当前引擎 token', () => {
    expect(resolveNoAutofillToken('text', null)).toBe(NO_AUTOFILL_TOKEN)
    expect(resolveNoAutofillToken(null, null)).toBe(NO_AUTOFILL_TOKEN)
    expect(resolveNoAutofillToken('text', 'off')).toBe(NO_AUTOFILL_TOKEN)
  })

  test('password 与密码管理器 token 豁免', () => {
    expect(resolveNoAutofillToken('password', null)).toBeNull()
    expect(resolveNoAutofillToken('password', 'current-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'current-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'new-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'username')).toBeNull()
  })
})

describe('applyNoAutofill', () => {
  test('裸 input 本体（MutationObserver addedNodes 场景）也打标', () => {
    // 回归：disableIn 此前只 querySelectorAll（不匹配 root 自身），
    // {editing && <input/>} 这类裸挂输入框永远拿不到标记 → 浏览器弹历史
    const el = fakeEl('INPUT', { type: 'text' })
    applyNoAutofill(el)
    expect(el.attrs.autocomplete).toBe(NO_AUTOFILL_TOKEN)
  })

  test('textarea / form 同样打标', () => {
    const ta = fakeEl('TEXTAREA')
    applyNoAutofill(ta as unknown as HTMLTextAreaElement)
    expect(ta.attrs.autocomplete).toBe(NO_AUTOFILL_TOKEN)
    const form = fakeEl('FORM')
    applyNoAutofill(form as unknown as HTMLFormElement)
    expect(form.attrs.autocomplete).toBe(NO_AUTOFILL_TOKEN)
  })

  test('password 与密码管理器 token 不动', () => {
    const pw = fakeEl('INPUT', { type: 'password' })
    applyNoAutofill(pw)
    expect(pw.attrs.autocomplete).toBeUndefined()
    const mgr = fakeEl('INPUT', { type: 'text', autocomplete: 'current-password' })
    applyNoAutofill(mgr)
    expect(mgr.attrs.autocomplete).toBe('current-password')
  })

  test('幂等：已打标不重复写', () => {
    const el = fakeEl('INPUT', { type: 'text', autocomplete: NO_AUTOFILL_TOKEN })
    applyNoAutofill(el)
    expect(el.attrs.autocomplete).toBe(NO_AUTOFILL_TOKEN)
  })
})
