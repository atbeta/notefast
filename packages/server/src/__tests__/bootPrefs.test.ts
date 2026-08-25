import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { injectBootPrefs } from '../web/bootPrefs'

const HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
  <head>
    <script>/* locale */</script>
  </head>
</html>`

describe('injectBootPrefs', () => {
  test('空偏好不改 HTML', () => {
    expect(injectBootPrefs(HTML, {})).toBe(HTML)
  })

  test('dark 写入 data-theme 与 __NF_PREFS', () => {
    const out = injectBootPrefs(HTML, { theme: 'dark' })
    expect(out).toContain('data-theme="dark"')
    expect(out).toContain('window.__NF_PREFS={"theme":"dark"}')
    expect(out.indexOf('__NF_PREFS')).toBeLessThan(out.indexOf('/* locale */'))
  })

  test('system 只注入 prefs，不改 data-theme（留给首屏脚本跟系统）', () => {
    const out = injectBootPrefs(HTML, { theme: 'system' })
    expect(out).toContain('data-theme="light"')
    expect(out).toContain('"theme":"system"')
  })

  test('locale 改 html lang', () => {
    const out = injectBootPrefs(HTML, { locale: 'en' })
    expect(out).toContain('<html lang="en" data-theme="light">')
  })

  test('已注入则不再写一份', () => {
    const once = injectBootPrefs(HTML, { theme: 'dark' })
    expect(injectBootPrefs(once, { theme: 'light' })).toBe(once)
  })

  test('源码里读 __NF_PREFS 不算已注入', () => {
    const src = `${HTML.replace('<head>', '<head><script>var boot=window.__NF_PREFS||{}</script>')}`
    const out = injectBootPrefs(src, { theme: 'dark' })
    expect(out).toContain('window.__NF_PREFS={"theme":"dark"}')
    expect(out).toContain('data-theme="dark"')
  })

  test('真实 index.html：dark + en 写入 head 最前', () => {
    const src = readFileSync(join(import.meta.dir, '../../../web/index.html'), 'utf8')
    const out = injectBootPrefs(src, { theme: 'dark', locale: 'en' })
    expect(out).toContain('<html lang="en" data-theme="dark">')
    expect(out).toMatch(/<head[^>]*>\s*<script>window\.__NF_PREFS=/)
    expect(out).toContain('"theme":"dark"')
    expect(out).toContain('"locale":"en"')
  })
})
