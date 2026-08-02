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

function makeChatConfig(overrides: Partial<ProviderDefinition> = {}): AiConfig {
  return {
    version: 1,
    chat: makeProvider(overrides),
    embedding: null,
    autoIndex: true,
    reranker: null,
  }
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
  test('掩码 chat 与 embedding 的 apiKey', () => {
    const cfg: AiConfig = {
      ...makeChatConfig({ apiKey: 'sk-verylong-secret-key-1234' }),
      embedding: makeProvider({ apiKey: 'sk-another-secret-key-12345' }),
    }
    const view = publicView(cfg)
    expect(view.chat).not.toBeNull()
    expect(view.chat!.apiKey).toBe('***set***')
    expect(view.chat!.baseUrl).toBe('https://api.example.com/v1')
    expect(view.chat!.chatModel).toBe('gpt-4o-mini')
    expect(view.embedding).not.toBeNull()
    expect(view.embedding!.apiKey).toBe('***set***')
  })

  test('空 chat 直接返回', () => {
    const cfg = emptyConfig()
    expect(publicView(cfg)).toEqual(cfg)
  })

  test('只配 chat 时 embedding=null 也正确', () => {
    const view = publicView(makeChatConfig())
    expect(view.chat).not.toBeNull()
    expect(view.embedding).toBeNull()
  })
})

describe('validateConfig', () => {
  test('空配置通过校验（视为禁用）', () => {
    expect(validateConfig(emptyConfig())).toEqual([])
  })

  test('chat baseUrl 为空报错', () => {
    const errs = validateConfig(makeChatConfig({ baseUrl: '' }))
    expect(errs.some((e) => e.includes('Chat provider baseUrl'))).toBe(true)
  })

  test('chat 缺 chatModel 报错', () => {
    const errs = validateConfig(makeChatConfig({ chatModel: '' }))
    expect(errs.some((e) => e.includes('Chat provider 必须填写 chatModel'))).toBe(true)
  })

  test('chat provider 可没有 embeddingModel', () => {
    // 旧版本要求 embedding 和 chat 至少一个；新版本已严格分离 —— chat 无需 embeddingModel
    const errs = validateConfig(makeChatConfig({ embeddingModel: '' }))
    expect(errs).toEqual([])
  })

  test('chat 缺 embedding 不影响 chat 通过校验', () => {
    const errs = validateConfig({ ...makeChatConfig(), embedding: null })
    expect(errs).toEqual([])
  })

  test('embedding provider 必须填 embeddingModel', () => {
    const cfg: AiConfig = {
      ...makeChatConfig(),
      embedding: makeProvider({ embeddingModel: '' }),
    }
    const errs = validateConfig(cfg)
    expect(errs.some((e) => e.includes('Embedding provider 必须填写 embeddingModel'))).toBe(true)
  })

  test('embedding provider 必须填 baseUrl', () => {
    const cfg: AiConfig = {
      ...makeChatConfig(),
      embedding: makeProvider({ baseUrl: '' }),
    }
    const errs = validateConfig(cfg)
    expect(errs.some((e) => e.includes('Embedding provider baseUrl'))).toBe(true)
  })

  test('embedding-only 合法（无 chat）', () => {
    const cfg: AiConfig = {
      version: 1,
      chat: null,
      embedding: makeProvider({ embeddingModel: 'bge-m3' }),
      autoIndex: true,
      reranker: null,
    }
    expect(validateConfig(cfg)).toEqual([])
  })

  test('非法 chat timeoutMs 报错', () => {
    expect(validateConfig(makeChatConfig({ timeoutMs: 100 })).length).toBeGreaterThan(0)
    expect(validateConfig(makeChatConfig({ timeoutMs: 999_999 })).length).toBeGreaterThan(0)
  })

  test('非法 embedding timeoutMs 报错', () => {
    const cfg: AiConfig = {
      ...makeChatConfig(),
      embedding: makeProvider({ timeoutMs: 100 }),
    }
    expect(validateConfig(cfg).length).toBeGreaterThan(0)
  })

  test('停用的 chat/embedding（enabled=false）跳过字段校验', () => {
    const cfg: AiConfig = {
      ...makeChatConfig({ baseUrl: '', chatModel: '', enabled: false }),
      embedding: makeProvider({ baseUrl: '', embeddingModel: '', enabled: false }),
    }
    expect(validateConfig(cfg)).toEqual([])
  })

  test('显式启用的 provider 仍校验字段', () => {
    const errs = validateConfig(makeChatConfig({ baseUrl: '', enabled: true }))
    expect(errs.some((e) => e.includes('Chat provider baseUrl'))).toBe(true)
  })
})

describe('configFromEnv', () => {
  test('完全空 env 返回空配置', () => {
    const cfg = configFromEnv({})
    expect(cfg.chat).toBeNull()
    expect(cfg.embedding).toBeNull()
  })

  test('AI_PROVIDER 命中预设 → 填充 baseUrl + 默认模型', () => {
    const cfg = configFromEnv({ AI_PROVIDER: 'siliconflow' })
    expect(cfg.chat).not.toBeNull()
    expect(cfg.chat!.preset).toBe('siliconflow')
    expect(cfg.chat!.baseUrl).toBe('https://api.siliconflow.cn/v1')
    expect(cfg.chat!.apiKey).toBe('')
  })

  test('LLM_API_KEY 单独也生效', () => {
    const cfg = configFromEnv({ LLM_API_KEY: 'sk-test', LLM_API_URL: 'https://x/v1', LLM_MODEL: 'm' })
    expect(cfg.chat).not.toBeNull()
    expect(cfg.chat!.apiKey).toBe('sk-test')
  })

  test('EMBEDDING_API_KEY 单独生效 → 生成 embedding provider', () => {
    const cfg = configFromEnv({ EMBEDDING_API_KEY: 'emb-key' })
    expect(cfg.embedding).not.toBeNull()
    expect(cfg.embedding!.apiKey).toBe('emb-key')
  })

  test('EMBEDDING_PROVIDER 命中预设 → 用对应 baseUrl', () => {
    const cfg = configFromEnv({ EMBEDDING_PROVIDER: 'voyage' })
    expect(cfg.embedding).not.toBeNull()
    expect(cfg.embedding!.preset).toBe('voyage')
    expect(cfg.embedding!.baseUrl).toBe('https://api.voyageai.com/v1')
  })

  test('LLM_API_KEY 同时没 EMBEDDING_* 时不会误建 embedding', () => {
    const cfg = configFromEnv({ LLM_API_KEY: 'sk-x' })
    expect(cfg.chat).not.toBeNull()
    expect(cfg.embedding).toBeNull()
  })
})
