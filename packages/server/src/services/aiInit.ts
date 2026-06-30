/**
 * AI 服务初始化
 *
 * 在 server 启动时调用。
 * 根据环境变量配置 Embedding Provider 和 LLM Provider。
 */

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

  const apiKey = (process.env.EMBEDDING_API_KEY || '').trim()
  if (!apiKey) {
    console.log('🧠 AI embedding: not configured (set EMBEDDING_API_KEY to enable)')
    return
  }

  // Embedding
  const embedProvider = createOpenAIProvider({
    EMBEDDING_API_KEY: apiKey,
    EMBEDDING_API_URL: (process.env.EMBEDDING_API_URL || '').trim(),
    EMBEDDING_MODEL: (process.env.EMBEDDING_MODEL || '').trim(),
  })
  setAiProvider(embedProvider)

  // LLM（优先级：LLM_API_KEY > EMBEDDING_API_KEY）
  const llmKey = (process.env.LLM_API_KEY || apiKey).trim()
  llmProvider = createOpenAILLM({
    LLM_API_KEY: llmKey,
    LLM_API_URL: (process.env.LLM_API_URL || '').trim(),
    LLM_MODEL: (process.env.LLM_MODEL || '').trim(),
    EMBEDDING_API_KEY: apiKey,
  })

  // 自动索引钩子
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

  console.log(`🧠 AI embedding: ${embedProvider.name}`)
  console.log(`💬 AI chat: ${llmProvider.name}`)
  console.log('   API: /api/v1/ai/search?q=...')
  console.log('   API: POST /api/v1/ai/suggest-title')
}
