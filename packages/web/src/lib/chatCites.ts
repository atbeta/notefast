/**
 * 把正文里的 [n] 拆成引用标记（仅 1…maxCite，避免 arr[1] 一类误伤过大）。
 */

export type CitePart = { type: 'text'; value: string } | { type: 'cite'; n: number }

const CITE_RE = /\[(\d{1,2})\]/g

export function splitCiteParts(text: string, maxCite: number): CitePart[] {
  if (maxCite < 1 || text.length === 0) return [{ type: 'text', value: text }]
  const parts: CitePart[] = []
  let last = 0
  CITE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITE_RE.exec(text)) !== null) {
    const n = Number(m[1])
    if (n < 1 || n > maxCite) continue
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) })
    parts.push({ type: 'cite', n })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  if (parts.length === 0) return [{ type: 'text', value: text }]
  return parts
}
