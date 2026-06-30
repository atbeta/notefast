import type { ProviderDefinition } from '../ai/config'

/** 测试辅助：构造一个默认合法的 provider definition */
export function makeProviderLike(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'test-provider',
    label: 'Test Provider',
    preset: 'custom',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-key',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    timeoutMs: 30_000,
    extraHeaders: {},
    ...overrides,
  }
}