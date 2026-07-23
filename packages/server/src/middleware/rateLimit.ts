import type { Context, Next } from 'hono'

interface RateLimitOpts {
  /** 每分钟最大请求数，默认 200 */
  perMin?: number
  /** 是否启用，默认 true */
  enabled?: boolean
}

const WINDOW_MS = 60_000

export function createRateLimit(opts?: RateLimitOpts) {
  const maxPerMin = opts?.perMin ?? parseInt(process.env.RATE_LIMIT_PER_MIN || '200', 10)
  const enabled = opts?.enabled ?? (process.env.RATE_LIMIT_ENABLED || 'true') !== 'false'

  if (!enabled || maxPerMin <= 0) return null

  const hits = new Map<string, number[]>()
  const expired = new Set<string>()

  // 定期清理整个 Map 里已经空的 key 列表（避免内存泄漏）
  let cleanupAt = 0

  return async function rateLimitMiddleware(c: Context, next: Next) {
    const path = c.req.path
    if (path === '/health' || path.startsWith('/api/v1/auth')) {
      return next()
    }

    const token = c.req.header('authorization')?.replace(/^bearer\s+/i, '')?.trim()
      || c.req.header('x-forwarded-for')
      || c.req.header('x-real-ip')
      || 'anonymous'

    const now = Date.now()
    const cutoff = now - WINDOW_MS

    let timestamps = hits.get(token)
    if (!timestamps) {
      timestamps = [now]
      hits.set(token, timestamps)
      return next()
    }

    const fresh = removeExpired(timestamps, cutoff)
    if (fresh.length === 0) {
      // 全部过期，直接覆盖（复用原数组避免 GC）
      timestamps.length = 0
      timestamps.push(now)
      if (expired.has(token)) expired.delete(token)
      return next()
    }

    if (fresh.length >= maxPerMin) {
      const retryAfter = Math.ceil((timestamps[timestamps.length - maxPerMin] + WINDOW_MS - now) / 1000)
      c.header('Retry-After', String(Math.max(retryAfter, 1)))
      return c.json({ error: 'rate_limited', message: '请求过于频繁，请稍后重试' }, 429)
    }

    timestamps.push(now)

    // 懒清理：每隔 60 秒扫一次整个 Map，删除过期的 key
    if (now > cleanupAt) {
      for (const [k, ts] of hits) {
        if (removeExpired(ts, cutoff).length === 0) {
          expired.add(k)
        }
      }
      for (const k of expired) {
        hits.delete(k)
      }
      expired.clear()
      cleanupAt = now + 60_000
    }

    return next()
  }
}

function removeExpired(timestamps: number[], cutoff: number): number[] {
  let i = 0
  while (i < timestamps.length && timestamps[i] < cutoff) {
    i++
  }
  if (i > 0) {
    timestamps.splice(0, i)
  }
  return timestamps
}
