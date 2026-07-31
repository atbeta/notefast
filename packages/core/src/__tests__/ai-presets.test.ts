/**
 * PRESETS shape tests
 *
 * 防止 PRESETS 在改动时手抖：
 * - baseUrl / 模型名 / requiresKey 写错
 * - extraHeaders 格式不一致
 * - 生成出来的 ProviderDefinition 跑不通过 validateConfig（custom 除外）
 */

import { describe, test, expect } from 'bun:test'
import {
  PRESETS,
  definitionFromPreset,
} from '../ai/presets'
import {
  validateConfig,
  type AiConfig,
  type ProviderPresetId,
} from '../ai/config'

const PRESET_IDS = Object.keys(PRESETS) as ProviderPresetId[]
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i

function preset(id: ProviderPresetId) {
  return PRESETS[id]
}

describe('PRESETS — shape contract', () => {
  test('每个 preset 都有完整字段（custom 允许 baseUrl 为空）', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      expect(p.id, `${id} missing id`).toBe(id)
      expect(typeof p.label).toBe('string')
      expect(p.label.length).toBeGreaterThan(0)
      expect(typeof p.baseUrl).toBe('string')
      if (id !== 'custom') expect(p.baseUrl.length, `${id} baseUrl empty`).toBeGreaterThan(0)
      expect(typeof p.embeddingModel).toBe('string')
      expect(typeof p.chatModel).toBe('string')
      expect(typeof p.requiresKey).toBe('boolean')
      expect(typeof p.extraHeaders).toBe('object')
      expect(Array.isArray(p.supportedModes)).toBe(true)
    }
  })

  test('非空 baseUrl 符合 URL 形状；custom 允许为空（用户填入）', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      if (p.baseUrl === '') {
        expect(id).toBe('custom')
        continue
      }
      expect(p.baseUrl, `${id} baseUrl invalid`).toMatch(URL_RE)
    }
  })

  test('baseUrl 不带尾部 slash', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      expect(p.baseUrl.endsWith('/'), `${id} baseUrl has trailing slash`).toBe(false)
    }
  })

  test('embedding 与 chat 模型名要么真实要么留空', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      const modelIdRe = /^[A-Za-z0-9._/-]+$/
      if (p.embeddingModel) expect(p.embeddingModel).toMatch(modelIdRe)
      if (p.chatModel) expect(p.chatModel).toMatch(modelIdRe)
    }
  })

  test('extraHeaders 的 value 必须是字符串', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      for (const [k, v] of Object.entries(p.extraHeaders)) {
        expect(typeof k).toBe('string')
        expect(typeof v).toBe('string')
        expect((v as string).length).toBeGreaterThan(0)
      }
    }
  })

  test('需要 key 的 preset 应该用 https 开头的官方域名', () => {
    for (const id of PRESET_IDS) {
      if (id === 'custom') continue
      const p = preset(id)
      expect(p.requiresKey, `${id} says requiresKey`).toBe(true)
      expect(p.baseUrl.startsWith('https://'), `${id} should use https`).toBe(true)
    }
  })

  test('每个 preset 可生成 ProviderDefinition；除 custom 之外通过 validateConfig', () => {
    for (const id of PRESET_IDS) {
      const def = definitionFromPreset(id)
      const p = preset(id)
      expect(def.id).toBeTruthy()
      expect(def.label).toBe(p.label)
      expect(def.preset).toBe(id)
      expect(def.baseUrl).toBe(p.baseUrl)
      expect(def.embeddingModel).toBe(p.embeddingModel)
      expect(def.chatModel).toBe(p.chatModel)
      expect(typeof def.timeoutMs).toBe('number')

      // 模拟真实使用：chat 预设放 chat 槽，embedding 预设放 embedding 槽；
      // 双能力预设两边都试一遍。
      const cfgAsChat: AiConfig = {
        version: 1,
        chat: def,
        embedding: null,
        autoIndex: true,
        reranker: null,
      }
      const cfgAsEmb: AiConfig = {
        version: 1,
        chat: null,
        embedding: def,
        autoIndex: true,
        reranker: null,
      }

      if (id === 'custom') {
        expect(validateConfig(cfgAsChat).length).toBeGreaterThan(0)
        expect(validateConfig(cfgAsEmb).length).toBeGreaterThan(0)
      } else if (p.chatModel && p.embeddingModel) {
        expect(validateConfig(cfgAsChat), `chat slot: ${id}`).toEqual([])
        expect(validateConfig(cfgAsEmb), `emb slot: ${id}`).toEqual([])
      } else if (p.chatModel) {
        expect(validateConfig(cfgAsChat), `chat-only ${id}`).toEqual([])
        expect(validateConfig(cfgAsEmb), `chat-only ${id} should fail emb slot`).not.toEqual([])
      } else if (p.embeddingModel) {
        expect(validateConfig(cfgAsChat), `emb-only ${id} should fail chat slot`).not.toEqual([])
        expect(validateConfig(cfgAsEmb), `emb-only ${id}`).toEqual([])
      }
    }
  })

  test('definitionFromPreset 可接收 apiKey 参数', () => {
    const def = definitionFromPreset('openai', 'sk-test-key')
    expect(def.apiKey).toBe('sk-test-key')
  })

  test('extraHeaders 通过 definitionFromPreset 拷贝（不与 preset 共享引用）', () => {
    const def = definitionFromPreset('openrouter')
    const original = { ...PRESETS.openrouter.extraHeaders }
    expect(def.extraHeaders).toEqual(original)
    def.extraHeaders['X-Title'] = 'MUTATED'
    expect(PRESETS.openrouter.extraHeaders['X-Title']).toBe(original['X-Title'])
  })

  test('每个 preset id 都唯一', () => {
    const ids = PRESET_IDS.map((id) => PRESETS[id].id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('每个 preset 都有 signupUrl（requiresKey=true 的服务）', () => {
    for (const id of PRESET_IDS) {
      const p = preset(id)
      if (p.requiresKey && id !== 'custom') {
        expect(typeof p.signupUrl, `${id} 缺 signupUrl`).toBe('string')
        expect(p.signupUrl!.length).toBeGreaterThan(0)
      }
    }
  })
})
