/**
 * 网页搜索（Brave Search API）
 *
 * Chat Agent Loop 中使用：当知识库内容不足时，LLM 可调用 notefast_web_search
 * 补充外部信息。搜索结果独立标注来源 URL，与笔记引用区分。
 */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search'

export async function searchWeb(query: string, apiKey: string, count = 5): Promise<WebSearchResult[]> {
  if (!apiKey) return []

  const url = `${BRAVE_API}?${new URLSearchParams({ q: query, count: String(Math.min(count, 10)) })}`

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Brave Search ${res.status}: ${text.slice(0, 200)}`)
  }

  const json = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }

  return (json.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }))
}
