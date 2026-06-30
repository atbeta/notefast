import { createOpenAIProvider } from '../ai/provider'
import { createOpenAILLM } from '../ai/llm'
import { initVectorStore } from '../ai/vector'
import { setAiProvider, indexBlock } from '../ai/indexer'
import { resolvePreset, listPresets } from '../ai/presets'
import type { LLMProvider } from '@notefast/core'
import type { PluginSystem } from '@notefast/core'

let llmProvider: LLMProvider | null = null

export function getLLMProvider(): LLMProvider | null {
  return llmProvider
}

export function initAiServices(pluginSystem: PluginSystem): void {
  initVectorStore()

  const apiKey = (process.env.AI_API_KEY || process.env.EMBEDDING_API_KEY || '').trim()
  if (!apiKey) {
    console.log('🧠 AI: not configured (set AI_API_KEY to enable)')
    if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
      console.log('   Available presets: ' + listPresets().map(p => p.key).join(', '))
    }
    return
  }

  const presetName = process.env.AI_PROVIDER || 'openrouter'
  const preset = resolvePreset(presetName)

  if (!preset) {
    console.log(`🧠 AI: unknown provider '${presetName}', falling back to openrouter`)
    const fallback = resolvePreset('openrouter')
    if (!fallback) return
    console.log(`🧠 AI: ${fallback.label}`)
    setupProviders(pluginSystem, apiKey, fallback)
    return
  }

  console.log(`🧠 AI: ${preset.label}`)
  setupProviders(pluginSystem, apiKey, preset)
}

function setupProviders(
  pluginSystem: PluginSystem,
  apiKey: string,
  preset: ReturnType<typeof resolvePreset> & {},
): void {
  const { embeddingUrl, embeddingModel, chatUrl, chatModel } = preset as NonNullable<typeof preset>

  if (embeddingUrl) {
    const embedProvider = createOpenAIProvider({
      EMBEDDING_API_URL: embeddingUrl,
      EMBEDDING_API_KEY: apiKey,
      EMBEDDING_MODEL: embeddingModel,
    })
    setAiProvider(embedProvider)

    pluginSystem.note.afterCreate.tap('ai-indexer', async (block) => {
      await indexBlock(block.id)
    })
    pluginSystem.note.afterUpdate.tap('ai-indexer', async (block) => {
      await indexBlock(block.id)
    })
    pluginSystem.note.afterDelete.tap('ai-indexer', async (blockId) => {
      const { deleteVector } = await import('../ai/vector')
      deleteVector(blockId)
    })

    console.log(`   Embedding: ${embeddingModel} @ ${embeddingUrl}`)
    console.log('   API: /api/v1/ai/search?q=...')
  }

  if (chatUrl) {
    llmProvider = createOpenAILLM({
      LLM_API_URL: chatUrl,
      LLM_API_KEY: apiKey,
      LLM_MODEL: chatModel,
      EMBEDDING_API_KEY: apiKey,
    })

    console.log(`   Chat: ${chatModel} @ ${chatUrl}`)
    console.log('   API: POST /api/v1/ai/suggest-title')
  }
}
