import { createOpenAIProvider } from '../ai/provider'
import { createOpenAILLM } from '../ai/llm'
import { initVectorStore } from '../ai/vector'
import { setAiProvider, indexBlock } from '../ai/indexer'
import type { LLMProvider } from '@notefast/core'
import type { PluginSystem } from '@notefast/core'

let llmProvider: LLMProvider | null = null

export function getLLMProvider(): LLMProvider | null {
  return llmProvider
}

export function initAiServices(pluginSystem: PluginSystem): void {
  initVectorStore()

  initEmbedding(pluginSystem)
  initLLM()
}

function initEmbedding(pluginSystem: PluginSystem): void {
  const url = process.env.EMBEDDING_API_URL || 'https://openrouter.ai/api/v1/embeddings'
  const key = (process.env.EMBEDDING_API_KEY || '').trim()
  const model = process.env.EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b'

  if (!key) {
    console.log('🧠 Embedding: not configured (set EMBEDDING_API_KEY)')
    return
  }

  const provider = createOpenAIProvider({
    EMBEDDING_API_URL: url,
    EMBEDDING_API_KEY: key,
    EMBEDDING_MODEL: model,
  })
  setAiProvider(provider)

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

  console.log(`🧠 Embedding: ${model} @ ${url}`)
}

function initLLM(): void {
  const url = process.env.LLM_API_URL || ''
  const key = (process.env.LLM_API_KEY || '').trim()
  const model = process.env.LLM_MODEL || ''

  if (!url || !key || !model) {
    console.log('💬 LLM: not configured (set LLM_API_URL + LLM_API_KEY + LLM_MODEL)')
    return
  }

  llmProvider = createOpenAILLM({
    LLM_API_URL: url,
    LLM_API_KEY: key,
    LLM_MODEL: model,
    EMBEDDING_API_KEY: key,
  })

  console.log(`💬 LLM: ${model} @ ${url}`)
}
