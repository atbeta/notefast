/**
 * OpenAI 兼容 HTTP 原语
 *
 * 沉淀 runtime / reranker 共用的请求层，避免各处重复：
 * - joinUrl / buildHeaders：URL 拼接与请求头构造
 * - postJson：POST JSON + 可选超时 + !res.ok 错误体截取 + JSON 解析
 * - streamSse：POST + SSE data: 行解析（遇 [DONE] 结束）
 *
 * 错误文案约定：`${errorLabel} ${status}: ${错误体前 300 字符}`。
 */

/** 拼接 baseUrl 与路径（去重斜杠） */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : '/' + path
  return b + p
}

/** 构造 JSON 请求头（可选 Bearer 与自定义头） */
export function buildHeaders(apiKey: string, extraHeaders?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) h['Authorization'] = `Bearer ${apiKey.trim()}`
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (k && v) h[k] = v
    }
  }
  return h
}

export interface PostOptions {
  /** 超时毫秒；不传则不设超时（请求也不附带 AbortSignal） */
  timeoutMs?: number
  /** 错误前缀，如 'LLM API' → `LLM API 500: <body 前 300 字符>` */
  errorLabel: string
}

/**
 * 发起 POST 请求；!res.ok（或 requireBody 且无 body）时读取错误体并抛错。
 * 成功时返回响应与计时器清理函数，由调用方决定计时覆盖范围。
 */
async function postRaw(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions & { requireBody?: boolean },
): Promise<{ res: Response; clear: () => void }> {
  const ac = new AbortController()
  const timer = opts.timeoutMs !== undefined ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(timer !== undefined ? { signal: ac.signal } : {}),
    })
    if (!res.ok || (opts.requireBody && !res.body)) {
      const err = await res.text().catch(() => '')
      throw new Error(`${opts.errorLabel} ${res.status}: ${err.slice(0, 300)}`)
    }
    return { res, clear }
  } catch (e) {
    clear()
    throw e
  }
}

/**
 * POST JSON 并解析响应为 JSON。
 * 若设置了 timeoutMs，计时覆盖到响应体解析完成。
 */
export async function postJson<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions,
): Promise<T> {
  const { res, clear } = await postRaw(fetchImpl, url, headers, body, opts)
  try {
    return (await res.json()) as T
  } finally {
    clear()
  }
}

/**
 * POST 并逐条产出 SSE data: 载荷文本（不含 [DONE]，遇到即结束；流 EOF 亦结束）。
 * 若设置了 timeoutMs，计时覆盖整个流读取过程。
 */
export async function* streamSse(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions,
): AsyncGenerator<string> {
  const { res, clear } = await postRaw(fetchImpl, url, headers, body, { ...opts, requireBody: true })
  try {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trimEnd()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    clear()
  }
}
