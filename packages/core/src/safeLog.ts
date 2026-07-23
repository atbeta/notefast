const SENSITIVE_KEYS = new Set([
  'apikey', 'api_key', 'password', 'token', 'secret', 'authorization',
  'accesskey', 'access_key', 'bearer',
])

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase())
}

function redactValue(value: unknown, key: string): unknown {
  if (typeof key === 'string' && isSensitive(key)) return '***'
  if (typeof value === 'string' && value.length > 0) {
    const lower = value.toLowerCase()
    if (lower.startsWith('sk-') || lower.startsWith('nf_') || lower.startsWith('bearer ')) return '***'
  }
  return value
}

function cloneAndRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((v) => cloneAndRedact(v))
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = redactValue(cloneAndRedact(value), key)
  }
  return result
}

export function safeLog(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
  const safeFields = fields ? cloneAndRedact(fields) as Record<string, unknown> : undefined
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(safeFields ?? {}) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function safeLogInfo(message: string, fields?: Record<string, unknown>): void {
  safeLog('info', message, fields)
}

export function safeLogWarn(message: string, fields?: Record<string, unknown>): void {
  safeLog('warn', message, fields)
}

export function safeLogError(message: string, fields?: Record<string, unknown>): void {
  safeLog('error', message, fields)
}
