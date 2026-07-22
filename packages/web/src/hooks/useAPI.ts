const API_BASE = '/api/v1'

/** 会话级密码（不保持登录时）：关闭浏览器自动清除 */
const PASSWORD_KEY = 'notefast.password'
/** 持久化登录（localStorage）：{ pw, exp }，7 天滑动过期 —— 每次有效读取自动顺延 */
const AUTH_KEY = 'notefast.auth'
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface PersistedAuth {
  pw: string
  /** 过期时间戳（ms） */
  exp: number
}

/** 读持久化登录；过期/脏数据自动清除，有效则滑动续期 7 天 */
function readPersisted(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedAuth
    if (typeof data.pw !== 'string' || !data.pw || typeof data.exp !== 'number') {
      throw new Error('malformed auth entry')
    }
    if (data.exp <= Date.now()) {
      localStorage.removeItem(AUTH_KEY)
      return null
    }
    localStorage.setItem(AUTH_KEY, JSON.stringify({ pw: data.pw, exp: Date.now() + AUTH_TTL_MS }))
    return data.pw
  } catch {
    try { localStorage.removeItem(AUTH_KEY) } catch { /* ignore */ }
    return null
  }
}

/** 返回当前可用的密码（优先持久化登录，其次会话级），否则 null */
export function getStoredPassword(): string | null {
  const persisted = readPersisted()
  if (persisted) return persisted
  try {
    return sessionStorage.getItem(PASSWORD_KEY)
  } catch {
    return null
  }
}

/**
 * 登录后写入；登出/清除时调用 clearStoredPassword()。
 * remember=true（默认）→ localStorage 7 天滑动过期；false → sessionStorage 会话级。
 */
export function setStoredPassword(pw: string, remember = true): void {
  clearStoredPassword()
  if (remember) {
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ pw, exp: Date.now() + AUTH_TTL_MS } satisfies PersistedAuth))
      return
    } catch {
      // localStorage 不可用（隐私模式等）→ 退回到会话级
    }
  }
  try {
    sessionStorage.setItem(PASSWORD_KEY, pw)
  } catch {
    // ignore — 隐私模式下 sessionStorage 也可能不可用
  }
}

export function clearStoredPassword(): void {
  try {
    sessionStorage.removeItem(PASSWORD_KEY)
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    // ignore
  }
}

/** 拼出当前会话的 Authorization header（如已登录），否则空 */
function authHeader(): Record<string, string> {
  const pw = getStoredPassword()
  if (!pw) return {}
  // 用户固定 admin（与服务端约定一致）；密码原值传给 btoa
  return { Authorization: 'Basic ' + btoa('admin:' + pw) }
}

/**
 * 直接 fetch 但自动拼 Authorization header。给 SSE / streaming 这种
 * 不能用 request() 的场景用。返回原生 Response，由调用方读 body。
 *
 * 401 时也会清掉旧密码（与 request() 行为一致）。
 */
export async function fetchWithAuth(path: string, options?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeader(), ...(options?.headers ?? {}) },
  })
  if (res.status === 401) clearStoredPassword()
  return res
}

/**
 * API 请求失败错误：在 message 之外保留 HTTP 状态码与已解析的响应体，
 * 供消费方读取服务端结构化错误（如 PUT /ai/config 400 的 errors[] 字段级校验）。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  })
  if (!res.ok) {
    // 响应体解析失败时 body 为 null，message 退回 statusText
    const body: unknown = await res.json().catch(() => null)
    const message = (body as { message?: string } | null)?.message || res.statusText || `HTTP ${res.status}`
    throw new ApiError(message, res.status, body)
  }
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export { request }
