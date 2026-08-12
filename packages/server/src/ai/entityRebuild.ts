/**
 * 全库实体重建 —— 与向量索引重建（vectorRebuild）对等的实体层重建
 *
 * 语义：清空 entity_mentions / entities 后逐块重抽（analyzeBlock），
 * 实体与 ai_auto 链按当前 prompt/配置重新生成；ai_auto 链不预清理
 * （findRefByPair 幂等，重抽只增不重评，与 reanalyzeDoc 语义一致）。
 *
 * 依赖 chat 模型（实体抽取），限速自然生效（rateLimitPerMinute 保护配额）；
 * 逐块串行 await，进度暴露供设置页轮询。
 */

import { getDb } from '../db'
import { fetchDocBlocks } from '../store/blocks'
import { loadAiExcludedDocIds } from './aiExclude'
import { hasRuntime, getRuntime } from '../services/aiRuntime'
import { analyzeBlockBatch } from './autoLink'

export interface EntityRebuildProgress {
  running: boolean
  total: number
  done: number
  errors: number
  started_at: string | null
  /** 预计剩余毫秒（有进度后估算） */
  eta_ms: number | null
  /** 最近一次错误信息（供 UI 展示失败原因） */
  last_error: string | null
}

let rebuilding = false
let progress: EntityRebuildProgress = { running: false, total: 0, done: 0, errors: 0, started_at: null, eta_ms: null, last_error: null }

export function getEntityRebuildProgress(): EntityRebuildProgress {
  return { ...progress }
}

/** 触发全库实体重建；已在重建时返回 false */
export function startEntityRebuild(): boolean {
  if (rebuilding) return false
  rebuilding = true
  progress = {
    running: true,
    total: 0,
    done: 0,
    errors: 0,
    started_at: new Date().toISOString(),
    eta_ms: null,
    last_error: null,
  }
  void runEntityRebuild()
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[entity-rebuild]', msg)
      progress.errors++
      progress.last_error = msg
    })
    .finally(() => {
      rebuilding = false
      progress = { ...progress, running: false, eta_ms: 0 }
    })
  return true
}

async function runEntityRebuild(): Promise<void> {
  const db = getDb()
  if (!hasRuntime() || !getRuntime().hasChat()) {
    throw new Error('Chat 模型未配置')
  }

  // 目标块：所有活文档的活块（文档根也登记实体）；ai_exclude 文档不参与（与其 purge 语义一致）
  const docRows = db
    .query("SELECT id FROM blocks WHERE type = 'document' AND is_deleted = 0")
    .all() as Array<{ id: string }>
  const excluded = loadAiExcludedDocIds(docRows.map((r) => r.id))
  const targets: Array<{ id: string; content: string; type: string }> = []
  for (const doc of docRows) {
    if (excluded.has(doc.id)) continue
    targets.push(...fetchDocBlocks(db, doc.id))
  }
  progress = { ...progress, total: targets.length }
  if (targets.length === 0) return

  // 重建语义：先清空再按新结果重抽（mention_count 从 0 累加，无残留无孤儿）
  db.query('DELETE FROM entity_mentions').run()
  db.query('DELETE FROM entities').run()

  // 批量重建：按字符预算分片合并 LLM 抽取（调用次数 ÷8+），逐块本地登记+建链；
  // skipRateLimit=true 绕过 30/min 全局限速——重建是显式全量操作，限速只会导致
  // 「大部分块被跳过、实体为空」（此前慢+空的同根源 bug）。
  // onProgress 每片回调 → 进度条逐批前进 + ETA 估算（此前一次性跑完、进度不动）。
  const startedAt = Date.parse(progress.started_at ?? '') || Date.now()
  const blocks = targets.map((row) => ({
    blockId: row.id,
    content: row.content ?? '',
    entitiesOnly: row.type === 'document',
  }))
  const res = await analyzeBlockBatch({
    blocks,
    skipRateLimit: true,
    onProgress: (done, total, errors) => {
      const elapsed = Math.max(0, Date.now() - startedAt)
      const remaining = Math.max(0, total - done)
      let eta: number | null = null
      if (done > 0 && remaining > 0 && elapsed > 0) {
        eta = Math.round((elapsed / done) * remaining)
      } else if (remaining === 0) {
        eta = 0
      }
      progress = { ...progress, done, total, errors, eta_ms: eta }
    },
  })
  progress = {
    ...progress,
    done: progress.total,
    errors: progress.errors + res.errors.length,
    eta_ms: 0,
    ...(res.errors.length > 0 ? { last_error: res.errors[res.errors.length - 1] ?? null } : {}),
  }
}

/** 测试用：重置重建状态（bun 测试跨文件共享模块状态） */
export function _resetEntityRebuildForTests(): void {
  rebuilding = false
  progress = { running: false, total: 0, done: 0, errors: 0, started_at: null, eta_ms: null, last_error: null }
}
