/**
 * Markdown 链接 href 分类。
 *
 * 浏览器会把无协议的 `url` 当成相对路径，在 /doc/:id 页点开就变成 /doc/url，
 * 整页 404。只把「带协议的绝对 URL / 站内绝对路径 / 页内锚点」当成可点击链接。
 */

export const MD_LINK_HREF_PLACEHOLDER = 'https://'

export type ResolvedMarkdownHref =
  | { kind: 'external' | 'internal' | 'hash'; href: string }
  | { kind: 'invalid' }

const UNSAFE_SCHEME = /^(javascript|data|vbscript|file):/i
/** 常见文件后缀不当成域名（notes.md 不是摩尔多瓦站点） */
const FILE_LIKE_TLD = new Set([
  'md', 'markdown', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'json', 'csv',
])

function looksLikeBareHost(href: string): boolean {
  const cut = href.search(/[/:?#]/)
  const host = (cut === -1 ? href : href.slice(0, cut)).toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(host)) return false
  const tld = host.slice(host.lastIndexOf('.') + 1)
  return tld.length >= 2 && !FILE_LIKE_TLD.has(tld)
}

export function resolveMarkdownHref(raw: string): ResolvedMarkdownHref {
  const href = raw.trim()
  if (!href) return { kind: 'invalid' }
  if (UNSAFE_SCHEME.test(href)) return { kind: 'invalid' }
  if (href.startsWith('#')) return { kind: 'hash', href }
  if (href.startsWith('/') && !href.startsWith('//')) return { kind: 'internal', href }

  try {
    const u = new URL(href)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (!u.hostname) return { kind: 'invalid' }
      return { kind: 'external', href: u.href }
    }
    if (u.protocol === 'mailto:' || u.protocol === 'tel:') {
      return { kind: 'external', href }
    }
    return { kind: 'invalid' }
  } catch {
    if (href.startsWith('//') && href.length > 2) {
      try {
        const u = new URL(`https:${href}`)
        if (u.hostname) return { kind: 'external', href: u.href }
      } catch {
        /* fall through */
      }
    }
    if (looksLikeBareHost(href)) {
      return { kind: 'external', href: `https://${href}` }
    }
    return { kind: 'invalid' }
  }
}
