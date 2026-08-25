/**
 * 把 highlight.js HTML 按源码换行切开，跨行 token 在断行处闭合再开启，
 * 避免按 `\n` 硬切把 `<span>` 拆坏。
 */

export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  let current = ''
  const open: string[] = []
  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i)
      if (end < 0) {
        current += html.slice(i)
        break
      }
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('</')) {
        open.pop()
        current += tag
      } else if (!tag.endsWith('/>')) {
        open.push(tag)
        current += tag
      } else {
        current += tag
      }
      i = end + 1
      continue
    }
    if (html[i] === '\n') {
      lines.push(current + closeTags(open))
      current = open.join('')
      i += 1
      continue
    }
    current += html[i]
    i += 1
  }
  lines.push(current)
  return lines
}

function closeTags(open: string[]): string {
  return [...open].reverse().map((tag) => {
    const name = tag.match(/^<([A-Za-z][\w:-]*)/)?.[1]
    return name ? `</${name}>` : ''
  }).join('')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
