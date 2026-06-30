/**
 * AI 服务初始化
 *
 * 在 server 启动时调用。
 * 根据环境变量配置 Embedding Provider，并注册生命周期钩子。
 */

import { createOpenAIProvider } from '../ai/provider'
import { initVectorStore } from '../ai/vector'
import { setAiProvider, indexBlock } from '../ai/indexer'
import type { PluginSystem } from '@notefast/core'

export function initAiServices(pluginSystem: PluginSystem): void {
  initVectorStore()

  const apiKey = (process.env.EMBEDDING_API_KEY || '').trim()
  if (!apiKey) {
    console.log('🧠 AI embedding: not configured (set EMBEDDING_API_KEY to enable)')
    return
  }

  const provider = createOpenAIProvider({
    EMBEDDING_API_KEY: apiKey,
    EMBEDDING_API_URL: (process.env.EMBEDDING_API_URL || '').trim(),
    EMBEDDING_MODEL: (process.env.EMBEDDING_MODEL || '').trim(),
  })

  setAiProvider(provider)

  // 注册自动索引钩子：block 创建或更新后重新生成向量
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

  console.log(`🧠 AI embedding: ${provider.name}`)
  console.log('   API: /api/v1/ai/search?q=...')
  console.log('   Reindex all: POST /api/v1/ai/index')
}
