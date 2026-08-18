/**
 * 全库实体重建 —— 与向量索引重建（vectorRebuild）对等的实体层重建
 *
 * 语义：清空 entity_mentions / entities 后逐块重抽（analyzeBlock），
 * 实体与 ai_auto 链按当前 prompt/配置重新生成；ai_auto 链不预清理
 * （findRefByPair 幂等，重抽只增不重评，与 reanalyzeDoc 语义一致）。
 *
 * 依赖 chat 模型（实体抽取）；全量重建跳过分钟限速，按字符预算分片批量调用。
 * 进度按「可抽取块」计数（过短块不进 LLM），同片建链并发，供设置页轮询。
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
  /** 过短 / 已排除、不送 LLM 的块数 */
  skipped: number
}

let rebuilding = false
let cancelRequested = false
let progress: EntityRebuildProgress = { running: false, total: 0, done: 0, errors: 0, started_at: null, eta_ms: null, last_error: null, skipped: 0 }

export function getEntityRebuildProgress(): EntityRebuildProgress {
  return { ...progress }
}

/** 请求取消重建：下一片开始前生效；已处理的实体/链保留（不回收） */
export function cancelEntityRebuild(): boolean {
  if (!rebuilding) return false
  cancelRequested = true
  return true
}

/** 触发全库实体重建；已在重建时返回 false */
export function startEntityRebuild(): boolean {
  if (rebuilding) return false
  rebuilding = true
  cancelRequested = false
  progress = {
    running: true,
    total: 0,
    done: 0,
    errors: 0,
    started_at: new Date().toISOString(),
    eta_ms: null,
    last_error: null,
    skipped: 0,
  }
  // 实体完整性状态：重建中（analyzed_blocks 保留旧值，UI 显示进行中）
  setEntityIndexState({ status: 'rebuilding', analyzedBlocks: progress.total, entityCount: 0, error: null })
  void runEntityRebuild()
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[entity-rebuild]', msg)
      progress.errors++
      progress.last_error = msg
      setEntityIndexState({ status: 'failed', analyzedBlocks: progress.total, entityCount: 0, error: msg })
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
  progress = { ...progress, total: 0, skipped: 0 }
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
    isCancelled: () => cancelRequested,
    onProgress: (done, total, errors, meta) => {
      const elapsed = Math.max(0, Date.now() - startedAt)
      const remaining = Math.max(0, total - done)
      let eta: number | null = null
      if (done > 0 && remaining > 0 && elapsed > 0) {
        eta = Math.round((elapsed / done) * remaining)
      } else if (remaining === 0) {
        eta = 0
      }
      progress = {
        ...progress,
        done,
        total,
        errors,
        eta_ms: eta,
        skipped: meta?.skipped ?? progress.skipped,
        last_error: meta?.lastError !== undefined && meta.lastError !== null ? meta.lastError : progress.last_error,
      }
    },
  })
  progress = {
    ...progress,
    done: progress.total,
    // onProgress 已写入累计 errors，勿再 + res.errors.length（会翻倍）
    errors: res.errors.length,
    eta_ms: 0,
    ...(res.errors.length > 0 ? { last_error: res.errors[res.errors.length - 1] ?? null } : {}),
  }
  // 取消时不改写实体完整性状态（保留重建前的状态；已处理的实体/链保留在库中）
  if (cancelRequested) return
  // 实体完整性状态：写入 entity_index_state（ready / failed），供设置页显示覆盖率
  const entityCount = (db.query('SELECT count(*) AS c FROM entities').get() as { c: number }).c
  // 有实体落库则标 ready：部分批次失败不应让设置页看起来像「什么都没建成」
  const failed = res.errors.length > 0 && entityCount === 0
  setEntityIndexState({
    status: failed ? 'failed' : 'ready',
    analyzedBlocks: progress.total,
    entityCount,
    error: res.errors.length > 0 ? (res.errors[res.errors.length - 1] ?? null) : null,
  })
}

/** 实体完整性状态（对应 entity_index_state 表） */
export interface EntityIndexState {
  status: 'empty' | 'ready' | 'rebuilding' | 'failed'
  analyzedBlocks: number
  entityCount: number
  error: string | null
}

export function getEntityIndexState(): EntityIndexState {
  try {
    const db = getDb()
    const row = db
      .query(
        `SELECT status, analyzed_blocks, entity_count, error
         FROM entity_index_state WHERE id = 'default'`,
      )
      .get() as { status: string; analyzed_blocks: number; entity_count: number; error: string | null } | undefined
    if (!row) return { status: 'empty', analyzedBlocks: 0, entityCount: 0, error: null }
    // entities 表被外部清空时状态回退 empty（覆盖一致性：行在但实体没了 → 感知为空）
    const entityCount = (db.query('SELECT count(*) AS c FROM entities').get() as { c: number }).c
    if (row.status !== 'rebuilding' && entityCount === 0 && row.entity_count > 0) {
      return { status: 'empty', analyzedBlocks: 0, entityCount: 0, error: null }
    }
    return {
      status: row.status as EntityIndexState['status'],
      analyzedBlocks: row.analyzed_blocks,
      entityCount: row.entity_count,
      error: row.error,
    }
  } catch {
    return { status: 'empty', analyzedBlocks: 0, entityCount: 0, error: null }
  }
}

export function setEntityIndexState(s: {
  status: 'empty' | 'ready' | 'rebuilding' | 'failed'
  analyzedBlocks: number
  entityCount: number
  error: string | null
}): void {
  try {
    const db = getDb()
    db.query(
      `UPDATE entity_index_state
       SET status = ?, analyzed_blocks = ?, entity_count = ?, error = ?, updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run(s.status, s.analyzedBlocks, s.entityCount, s.error)
  } catch {
    /* 状态写入失败不影响重建主流程 */
  }
}

/** 测试用：重置重建状态（bun 测试跨文件共享模块状态） */
export function _resetEntityRebuildForTests(): void {
  rebuilding = false
  cancelRequested = false
  progress = { running: false, total: 0, done: 0, errors: 0, started_at: null, eta_ms: null, last_error: null, skipped: 0 }
  try {
    getDb()
      .query(
        `UPDATE entity_index_state SET status = 'empty', analyzed_blocks = 0, entity_count = 0, error = NULL
         WHERE id = 'default'`,
      )
      .run()
  } catch {
    /* 状态表未初始化时忽略 */
  }
}
