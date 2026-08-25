/**
 * 把 data/ui-preferences.json 写进 engine 吐出的 index.html。
 * 原生壳 origin 随端口变，localStorage 不可靠；首屏必须在 HTML 里带上主题/语言。
 */

export interface BootPrefs {
  theme?: string
  locale?: string
}

export function prefsForBoot(prefs: Record<string, unknown>): BootPrefs {
  const theme = typeof prefs.theme === 'string' ? prefs.theme : undefined
  const locale = typeof prefs.locale === 'string' ? prefs.locale : undefined
  return { theme, locale }
}

/** 注入 window.__NF_PREFS；light/dark 同时改 <html data-theme>，避免脚本前先闪系统色 */
export function injectBootPrefs(html: string, prefs: Record<string, unknown>): string {
  if (html.includes('window.__NF_PREFS=')) return html
  const boot = prefsForBoot(prefs)
  if (!boot.theme && !boot.locale) return html

  let out = html
  if (boot.theme === 'light' || boot.theme === 'dark') {
    if (/data-theme="[^"]*"/.test(out)) {
      out = out.replace(/data-theme="[^"]*"/, `data-theme="${boot.theme}"`)
    }
  }
  if (boot.locale && boot.locale !== 'system' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(boot.locale)) {
    out = out.replace(/<html([^>]*)\slang="[^"]*"/, `<html$1 lang="${boot.locale}"`)
  }

  const script = `<script>window.__NF_PREFS=${JSON.stringify(boot)}</script>`
  if (/<head[^>]*>/i.test(out)) {
    return out.replace(/<head[^>]*>/i, (open) => `${open}${script}`)
  }
  return `${script}${out}`
}
