export interface FtsQuery {
  query: string
  limit: number
  offset: number
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
