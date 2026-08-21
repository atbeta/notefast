import { describe, expect, test, beforeEach } from 'bun:test'
import {
  loadTagCatalog,
  peekTagCatalog,
  rememberTagCatalog,
  resetTagCatalog,
  subscribeTagCatalog,
  type TagCatalogPayload,
} from '../tagCatalog'

const sample: TagCatalogPayload = {
  provider: 'properties',
  tags: [{ tag: 'mcp', count: 3 }],
}

beforeEach(() => {
  resetTagCatalog()
})

describe('tagCatalog', () => {
  test('peek 默认空；remember 后可读', () => {
    expect(peekTagCatalog()).toBeNull()
    rememberTagCatalog(sample)
    expect(peekTagCatalog()).toEqual(sample)
  })

  test('subscribe 在 remember 时通知', () => {
    let n = 0
    const unsub = subscribeTagCatalog(() => { n += 1 })
    rememberTagCatalog(sample)
    expect(n).toBe(1)
    unsub()
    rememberTagCatalog(sample)
    expect(n).toBe(1)
  })

  test('并发 load 共用一个 in-flight', async () => {
    let calls = 0
    const fetcher = () => {
      calls += 1
      return Promise.resolve(sample)
    }
    const [a, b] = await Promise.all([loadTagCatalog(fetcher), loadTagCatalog(fetcher)])
    expect(calls).toBe(1)
    expect(a).toEqual(sample)
    expect(b).toEqual(sample)
    expect(peekTagCatalog()).toEqual(sample)
  })

  test('失败不写入缓存，后续可重试', async () => {
    await expect(loadTagCatalog(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(peekTagCatalog()).toBeNull()
    const ok = await loadTagCatalog(() => Promise.resolve(sample))
    expect(ok).toEqual(sample)
  })
})
