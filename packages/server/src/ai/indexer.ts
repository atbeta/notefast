/**
 * 自动索引服务
 *
 * 配置 PROVIDER 后：
 * - 新的 block 创建时自动生成向量
 * - block 内容更新时自动更新向量
 * - 通过生命周期钩子注册，不侵入现有 API 代码
 */

import type { EmbeddingProvider } from '@notefast/core'
import { truncateText } from '@notefast/core'
import { getDb } from '../db'
import { upsertVector, deleteVector } from './vector'
import type { BlockRow } from '@notefast/core'

export interface AiConfig {
  provider?: EmbeddingProvider
  enabled: boolean
}

let aiConfig: AiConfig = { enabled: false }

export function setAiProvider(provider: EmbeddingProvider): void {
  aiConfig = { provider, enabled: true }
  console.log(`🧠 AI embedding enabled: ${provider.name}`)
}

export function disableAiProvider(): void {
  aiConfig = { enabled: false }
  console.log('🧠 AI embedding disabled')
}

export function getAiConfig(): AiConfig {
  return aiConfig
}

export async function indexBlock(blockId: string): Promise<void> {
  if (!aiConfig.enabled || !aiConfig.provider) return

  const db = getDb()
  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(blockId) as BlockRow | undefined
  if (!row) return

  const text = row.content || ''
  if (!text.trim()) {
    deleteVector(blockId)
    return
  }

  const provider = aiConfig.provider
  const truncated = truncateText(text, provider.maxTokens)

  try {
    const vectors = await provider.embedBatch([truncated])
    if (vectors.length > 0) {
      upsertVector(blockId, vectors[0])
    }
  } catch (e) {
    console.error(`Failed to index block ${blockId}:`, e)
  }
}

export async function indexAllBlocks(notebookId?: string): Promise<{ indexed: number; errors: number }> {
  if (!aiConfig.enabled || !aiConfig.provider) {
    throw new Error('AI embedding provider not configured')
  }

  const db = getDb()
  let sql = 'SELECT id, content FROM blocks WHERE content IS NOT NULL AND content != ?'
  const params: string[] = ['']
  if (notebookId) { sql += ' AND notebook_id = ?'; params.push(notebookId) }

  const rows = db.query(sql).all(...params) as Array<{ id: string; content: string }>
  if (rows.length === 0) return { indexed: 0, errors: 0 }

  const provider = aiConfig.provider
  const batches: Array<{ id: string; text: string }[]> = []
  for (let i = 0; i < rows.length; i += provider.batchSize) {
    batches.push(rows.slice(i, i + provider.batchSize).map((r) => ({
      id: r.id,
      text: truncateText(r.content, provider.maxTokens),
    })))
  }

  let indexed = 0
  let errors = 0

  for (const batch of batches) {
    try {
      const vectors = await provider.embedBatch(batch.map((b) => b.text))
      for (let i = 0; i < batch.length && i < vectors.length; i++) {
        upsertVector(batch[i].id, vectors[i])
        indexed++
      }
    } catch (e) {
      console.error(`Batch indexing error:`, e)
      errors += batch.length
    }
  }

  return { indexed, errors }
}
