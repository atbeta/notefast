import { describe, test, expect } from 'bun:test'
import {
  maskKey,
  publicView,
  validateConfig,
  configFromEnv,
  emptyConfig,
  type AiConfig,
  type ProviderDefinition,
} from '../ai/config'

function makeProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'test-id',
    label: 'Test',
    preset: 'custom',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-1234567890abcdef',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    timeoutMs: 30_000,
    extraHeaders: {},
    ...overrides,
  }
}

function makeConfig(overrides: Partial<ProviderDefinition> = {}): AiConfig {
  return { version: 1, active: makeProvider(overrides), autoIndex: true }
}

describe('maskKey', () => {
  test('空 key 返回空串', () => {
    expect(maskKey('')).toBe('')
  })
  test('短 key 一律替换为 ••••', () => {
    expect(maskKey('abcd')).toBe('••••')
  })
  test('长 key 仅显示首 4 + 尾 4', () => {
    expect(maskKey('sk-abcdefgh12345678ijkl')).toBe('sk-a••••ijkl')
  })
})

describe('publicView', () => {
  test('掩码 apiKey，保留其他字段', () => {
    const cfg = makeConfig({ apiKey: 'sk-verylong-secret-key-1234' })
    const view = publicView(cfg)
    expect(view.active).not.toBeNull()
    expect(view.active!.apiKey).toBe('***set***')
    expect(view.active!.baseUrl).toBe('https://api.example.com/v1')
    expect(view.active!.chatModel).toBe('gpt-4o-mini')
  })

  test('空 active 直接返回', () => {
    const cfg = emptyConfig()
    expect(publicView(cfg)).toEqual(cfg)
  })
})

describe('validateConfig', () => {
  test('空 active 通过校验（视为禁用）', () => {
    expect(validateConfig(emptyConfig())).toEqual([])
  })

  test('baseUrl 为空报错', () => {
    const cfg = makeConfig({ baseUrl: '' })
    const errs = validateConfig(cfg)
    expect(errs.some((e) => e.includes('baseUrl'))).toBe(true)
  })

  test('embedding 和 chat 都为空报错', () => {
    const cfg = makeConfig({ embeddingModel: '', chatModel: '' })
    const errs = validateConfig(cfg)
    expect(errs.some((e) => e.includes('至少填写一个'))).toBe(true)
  })

  test('只配 chat 不报错', () => {
    const cfg = makeConfig({ embeddingModel: '' })
    expect(validateConfig(cfg)).toEqual([])
  })

  test('只配 embedding 不报错', () => {
    const cfg = makeConfig({ chatModel: '' })
    expect(validateConfig(cfg)).toEqual([])
  })

  test('非法 timeoutMs 报错', () => {
    expect(validateConfig(makeConfig({ timeoutMs: 100 })).length).toBeGreaterThan(0)
    expect(validateConfig(makeConfig({ timeoutMs: 999_999 })).length).toBeGreaterThan(0)
  })
})

describe('configFromEnv', () => {
  test('完全空 env 返回空配置', () => {
    const cfg = configFromEnv({})
    expect(cfg.active).toBeNull()
  })

  test('只要有任一 env 变量就生成 provider', () => {
    const cfg = configFromEnv({ LLM_API_KEY: 'sk-test' })
    expect(cfg.active).not.toBeNull()
    expect(cfg.active!.apiKey).toBe('sk-test')
  })

  test('LLM_API_KEY 优先于 EMBEDDING_API_KEY', () => {
    const cfg = configFromEnv({ LLM_API_KEY: 'llm-key', EMBEDDING_API_KEY: 'emb-key' })
    expect(cfg.active!.apiKey).toBe('llm-key')
  })

  test('只设 EMBEDDING_API_KEY 时被采纳', () => {
    const cfg = configFromEnv({ EMBEDDING_API_KEY: 'emb-key' })
    expect(cfg.active!.apiKey).toBe('emb-key')
  })
})