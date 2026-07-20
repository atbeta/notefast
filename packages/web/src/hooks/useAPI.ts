const API_BASE = '/api/v1'

/** Web UI 登录后存到 sessionStorage 的密码（关闭浏览器自动清除） */
const PASSWORD_KEY = 'notefast.password'

/** 返回当前会话的密码（如已登录），否则 null */
export function getStoredPassword(): string | null {
  try {
    return sessionStorage.getItem(PASSWORD_KEY)
  } catch {
    return null
  }
}

/** 登录后写入；登出/清除时调用 */
export function setStoredPassword(pw: string): void {
  try {
    sessionStorage.setItem(PASSWORD_KEY, pw)
  } catch {
    // ignore — 隐私模式下 sessionStorage 不可用
  }
}

export function clearStoredPassword(): void {
  try {
    sessionStorage.removeItem(PASSWORD_KEY)
  } catch {
    // ignore
  }
}

/** 拼出当前会话的 Authorization header（如已登录），否则空 */
export function authHeader(): Record<string, string> {
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.message || `HTTP ${res.status}`)
  }
  return res.json()
}

export function useAPI() {
  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
    put: <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export { request }
