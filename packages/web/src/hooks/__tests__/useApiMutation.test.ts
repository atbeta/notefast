import { describe, test, expect } from 'bun:test'
import { nextRetryDecision } from '../useApiMutation'
import { ApiError } from '../useAPI'

describe('nextRetryDecision', () => {
  test('ApiError → 不重试', () => {
    const d = nextRetryDecision(new ApiError('bad request', 400, null), 0, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(false)
    expect(d.delayMs).toBeUndefined()
  })

  test('ApiError 5xx 也算契约性错误，不重试', () => {
    const d = nextRetryDecision(new ApiError('server error', 500, null), 0, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(false)
  })

  test('network error 第一次 → 重试 + 退避延迟', () => {
    const d = nextRetryDecision(new TypeError('Failed to fetch'), 0, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(true)
    // base=400, jitter 0–100, total 400–500
    expect(d.delayMs!).toBeGreaterThanOrEqual(400)
    expect(d.delayMs!).toBeLessThan(500)
  })

  test('network error 第二次 → 退避翻倍', () => {
    const d = nextRetryDecision(new TypeError('Failed to fetch'), 1, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(true)
    // base=800, jitter 0–200, total 800–1000
    expect(d.delayMs!).toBeGreaterThanOrEqual(800)
    expect(d.delayMs!).toBeLessThan(1000)
  })

  test('最后一次 → 不再重试', () => {
    const d = nextRetryDecision(new TypeError('Failed to fetch'), 2, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(false)
  })

  test('attempts=1（不重试模式） → 直接 stop', () => {
    const d = nextRetryDecision(new TypeError('Failed to fetch'), 0, 1, 400, 5_000)
    expect(d.shouldRetry).toBe(false)
  })

  test('退避延迟不超过 maxDelayMs 上限', () => {
    // 假设第 5 次，base=400*2^5=12800 → clamp 到 maxDelayMs=2000
    const d = nextRetryDecision(new TypeError('Failed to fetch'), 5, 10, 400, 2_000)
    expect(d.shouldRetry).toBe(true)
    // clamp 到 2000 + jitter 0–500 = 2000–2500
    expect(d.delayMs!).toBeGreaterThanOrEqual(2_000)
    expect(d.delayMs!).toBeLessThan(2_500)
  })

  test('未知 error 形态走 network error 路径', () => {
    const d = nextRetryDecision('weird string error', 0, 3, 400, 5_000)
    expect(d.shouldRetry).toBe(true)
  })
})