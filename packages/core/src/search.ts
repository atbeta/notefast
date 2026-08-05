export interface FtsQuery {
  query: string
  limit: number
  offset: number
}

/**
 * 全角 → 半角（U+FF01–FF5E → ASCII，全角空格 U+3000 → 空格）。
 * 仅作用于 ASCII 区与全角空格，中文不受影响——术语场景的高频变体
 * （「（EDA）」「，」。全角括号/标点/数字）在查询端归一，与库内半角写法对齐。
 * 注意：仅查询端/匹配键使用，不改变实体归并键（实体表存量保持稳定）。
 */
export function fullToHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0)
    } else if (ch === '\u3000') {
      out += ' '
    } else {
      out += ch
    }
  }
  return out
}

/**
 * 标点/数字/空格 → 全角（ASCII 标点与 0x30–0x39 → U+FF01–FF5E 对应位，空格 → U+3000）。
 * 字母保持半角——中文文档的常规写法是「RAG（检索增强生成）」（拉丁字母半角、括号全角），
 * 与 fullToHalfWidth 配对做双形态匹配：查询半角「RAG(检索增强生成)」的
 * 标点全角形态「RAG（检索增强生成）」能命中全角标点的文档内容。
 */
export function halfToFullPunct(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if ((code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0x7e) ||
        (code >= 0x30 && code <= 0x39)) {
      out += String.fromCharCode(code + 0xfee0)
    } else if (ch === ' ') {
      out += '\u3000'
    } else {
      out += ch
    }
  }
  return out
}

export function buildFtsQuery(text: string, limit = 20, offset = 0): FtsQuery {
  const escaped = text.replace(/['"*()]/g, ' ').trim()
  if (!escaped) {
    return { query: '', limit, offset }
  }

  const terms = escaped.split(/\s+/)
  const query = terms.map((t) => `"${t}"`).join(' AND ')

  return { query, limit, offset }
}

export function highlightSnippet(content: string, query: string, contextLen = 60): string {
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return content.slice(0, contextLen * 2)
  }

  let bestPos = -1
  let bestScore = 0

  for (let i = 0; i < terms.length; i++) {
    const pos = content.toLowerCase().indexOf(terms[i].toLowerCase())
    if (pos >= 0) {
      let score = 1
      for (let j = i + 1; j < terms.length; j++) {
        const nextPos = content.toLowerCase().indexOf(terms[j].toLowerCase(), pos)
        if (nextPos >= 0 && nextPos - pos < contextLen) {
          score++
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestPos = pos
      }
    }
  }

  if (bestPos < 0) {
    return content.slice(0, contextLen * 2)
  }

  const start = Math.max(0, bestPos - contextLen)
  const end = Math.min(content.length, bestPos + contextLen)
  let snippet = content.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < content.length) snippet += '...'

  return snippet
}
