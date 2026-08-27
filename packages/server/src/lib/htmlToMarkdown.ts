/**
 * 把 mammoth 产出的 HTML 片段转成 Markdown。
 *
 * 不引入 turndown：mammoth 标签集封闭（p/h1-6/ul/ol/li/table/a/img/strong/em），
 * 且其已弃用的 convertToMarkdown 会把标题书签写成 `<a id="..."></a>`，
 * 未知标签只保留子孙文本，正好清掉残留 XML/HTML 壳。
 */

interface El {
  tag: string
  attrs: Record<string, string>
  children: Array<El | string>
}

const VOID = new Set(['br', 'img', 'hr'])

export function htmlToMarkdown(html: string): string {
  const nodes = parseFragment(html)
  return collapseNewlines(block(nodes)).trim()
}

function parseFragment(html: string): Array<El | string> {
  const root: El = { tag: '#root', attrs: {}, children: [] }
  const stack: El[] = [root]
  const re =
    /<!--[\s\S]*?-->|<([a-zA-Z][\w:-]*)([^>]*?)\s*\/>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const parent = stack[stack.length - 1]!
    if (m[1]) {
      const el: El = { tag: m[1], attrs: parseAttrs(m[2] ?? ''), children: [] }
      parent.children.push(el)
      continue
    }
    if (m[3]) {
      const close = m[3].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag.toLowerCase() === close) {
          stack.length = i
          break
        }
      }
      continue
    }
    if (m[4]) {
      const tag = m[4]
      const el: El = { tag, attrs: parseAttrs(m[5] ?? ''), children: [] }
      parent.children.push(el)
      if (!VOID.has(tag.toLowerCase())) stack.push(el)
      continue
    }
    if (m[6]) parent.children.push(m[6])
  }
  return root.children
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([:@\w-]+)\s*=\s*"([^"]*)"|([:@\w-]+)\s*=\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m[1]) attrs[m[1].toLowerCase()] = m[2] ?? ''
    else if (m[3]) attrs[m[3].toLowerCase()] = m[4] ?? ''
  }
  return attrs
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
}

function textContent(nodes: Array<El | string>): string {
  return nodes.map((n) => (typeof n === 'string' ? decode(n) : textContent(n.children))).join('')
}

function inline(nodes: Array<El | string>): string {
  return nodes.map((n) => {
    if (typeof n === 'string') return decode(n)
    const tag = n.tag.toLowerCase()
    const inner = inline(n.children)
    if (tag === 'strong' || tag === 'b') return inner ? `**${inner}**` : ''
    if (tag === 'em' || tag === 'i') return inner ? `*${inner}*` : ''
    if (tag === 'code') return inner ? `\`${inner}\`` : ''
    if (tag === 's' || tag === 'del' || tag === 'strike') return inner ? `~~${inner}~~` : ''
    if (tag === 'br') return '\n'
    if (tag === 'a') {
      const href = (n.attrs.href || '').trim()
      if (!href) return inner
      return `[${inner}](${href})`
    }
    if (tag === 'img') {
      const src = (n.attrs.src || '').trim()
      if (!src) return ''
      return `![${n.attrs.alt || ''}](${src})`
    }
    return inner
  }).join('')
}

function listToMd(list: El, ordered: boolean, indent = 0): string {
  const pad = '  '.repeat(indent)
  const lines: string[] = []
  let i = 1
  for (const child of list.children) {
    if (typeof child === 'string' || child.tag.toLowerCase() !== 'li') continue
    const nested: string[] = []
    const inlineNodes: Array<El | string> = []
    for (const c of child.children) {
      if (typeof c !== 'string' && (c.tag.toLowerCase() === 'ul' || c.tag.toLowerCase() === 'ol')) {
        nested.push(listToMd(c, c.tag.toLowerCase() === 'ol', indent + 1))
      } else {
        inlineNodes.push(c)
      }
    }
    const bullet = ordered ? `${i}. ` : '- '
    i++
    lines.push(pad + bullet + inline(inlineNodes).trim())
    for (const n of nested) if (n) lines.push(n)
  }
  return lines.join('\n')
}

function tableToMd(table: El): string {
  const rows: El[] = []
  const walk = (n: El | string) => {
    if (typeof n === 'string') return
    if (n.tag.toLowerCase() === 'tr') rows.push(n)
    else n.children.forEach(walk)
  }
  table.children.forEach(walk)
  if (rows.length === 0) return ''
  const cellsOf = (tr: El) =>
    tr.children.filter((c): c is El => typeof c !== 'string' && /^(td|th)$/i.test(c.tag))
  const fmt = (cells: El[]) =>
    '| ' + cells.map((c) => inline(c.children).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()).join(' | ') + ' |'
  const header = cellsOf(rows[0]!)
  if (header.length === 0) return textContent(table.children).trim()
  const lines = [fmt(header), '| ' + header.map(() => '---').join(' | ') + ' |']
  for (const tr of rows.slice(1)) lines.push(fmt(cellsOf(tr)))
  return lines.join('\n')
}

function isBlockTag(tag: string): boolean {
  return /^(p|h[1-6]|ul|ol|table|pre|blockquote|div|tr|thead|tbody|tfoot)$/i.test(tag)
}

function block(nodes: Array<El | string>): string {
  const parts: string[] = []
  for (const n of nodes) {
    if (typeof n === 'string') {
      const t = decode(n).trim()
      if (t) parts.push(t)
      continue
    }
    const tag = n.tag.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      parts.push(`${'#'.repeat(Number(tag[1]))} ${inline(n.children).trim()}`)
    } else if (tag === 'p') {
      const t = inline(n.children).trim()
      if (t) parts.push(t)
    } else if (tag === 'ul' || tag === 'ol') {
      const t = listToMd(n, tag === 'ol')
      if (t) parts.push(t)
    } else if (tag === 'table') {
      const t = tableToMd(n)
      if (t) parts.push(t)
    } else if (tag === 'pre') {
      parts.push('```\n' + textContent(n.children).replace(/\n$/, '') + '\n```')
    } else if (tag === 'blockquote') {
      const inner = block(n.children).trim()
      if (inner) parts.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'))
    } else if (tag === 'br') {
      parts.push('')
    } else if (isBlockTag(tag) || n.children.some((c) => typeof c !== 'string' && isBlockTag(c.tag))) {
      const inner = block(n.children).trim()
      if (inner) parts.push(inner)
    } else {
      const t = inline(n.children).trim()
      if (t) parts.push(t)
    }
  }
  return parts.join('\n\n')
}

function collapseNewlines(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n')
}
