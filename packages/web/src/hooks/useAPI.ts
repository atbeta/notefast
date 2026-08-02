import i18next from '../i18n'

const API_BASE = '/api/v1'

/** 持久化登录（localStorage）：{ token, exp }，7 天滑动过期 */
const TOKEN_KEY = 'notefast.session'
/** 会话级 token（不保持登录时）：关闭浏览器自动清除 */
const TOKEN_SESSION_KEY = 'notefast.session.temp'
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface PersistedSession {
  token: string
  exp: number
}

function readPersistedToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedSession
    if (typeof data.token !== 'string' || !data.token || typeof data.exp !== 'number') {
      throw new Error('malformed session entry')
    }
    if (data.exp <= Date.now()) {
      localStorage.removeItem(TOKEN_KEY)
      return null
    }
    // 滑动续期
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, exp: Date.now() + AUTH_TTL_MS }))
    return data.token
  } catch {
    try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
    return null
  }
}

export function getStoredToken(): string | null {
  const persisted = readPersistedToken()
  if (persisted) return persisted
  try {
    return sessionStorage.getItem(TOKEN_SESSION_KEY)
  } catch {
    return null
  }
}

export function saveSessionToken(token: string, remember = true): void {
  clearSession()
  if (remember) {
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + AUTH_TTL_MS } satisfies PersistedSession))
      return
    } catch { /* fall through to session-level */ }
  }
  try {
    sessionStorage.setItem(TOKEN_SESSION_KEY, token)
  } catch { /* ignore */ }
}

export function clearSession(): void {
  try { sessionStorage.removeItem(TOKEN_SESSION_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  // 通知服务端撤销 token（fire-and-forget）
  try {
    fetch(`${API_BASE}/auth/session`, { method: 'DELETE' }).catch(() => {})
  } catch { /* ignore */ }
}

function authHeader(): Record<string, string> {
  const token = getStoredToken()
  if (token) return { Authorization: `Bearer ${token}` }
  return {}
}

export async function fetchWithAuth(path: string, options?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      // 服务端据此本地化 AI 提示词（chat 系统提示/工具描述/skills/标题生成）
      'Accept-Language': i18next.resolvedLanguage || i18next.language || 'zh-CN',
      ...authHeader(),
      ...(options?.headers ?? {}),
    },
  })
  if (res.status === 401) clearSession()
  return res
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    // 服务端错误带稳定 code（error 字段）时，非中文 UI 用 code→本地化文案替换 message，
    // 避免英文界面混入中文；中文 UI 保留服务端富消息（带参数详情）。
    const code = (body as { error?: string } | null)?.error
    const lng = i18next.resolvedLanguage || i18next.language || 'zh-CN'
    super(lng !== 'zh-CN' && code && i18next.exists(`errors.${code}`)
      ? i18next.t(`errors.${code}`)
      : message)
    this.name = 'ApiError'
  }

  /** 服务端错误码（body.error）；未知或缺失时为 undefined */
  get code(): string | undefined {
    return (this.body as { error?: string } | null)?.error
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    const message = (body as { message?: string } | null)?.message || res.statusText || i18next.t('common.httpError', { status: res.status })
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
