/**
 * vault 文档元数据：frontmatter 三键（tags / notefast_ai_exclude / notefast_status）
 * 的读口径与指纹计算（RFC 0001 D8、RFC 0003 阶段 B）。
 *
 * 单独成模块的理由：ingest（文件 → 库）与 writeback（库 → 文件）必须用**同一套**
 * 读取与指纹算法，否则回声判定会两边不一致。
 */

import { readAiExclude, readDocStatus, readTags, type BlockRow, type DocStatus } from '@notefast/core'
import { sha256Hex } from './writer'

/** 写回时 NoteFast 管理的三键（其余 frontmatter 行零改动） */
export interface VaultDocMeta {
  tags: string[]
  aiExclude: boolean
  status: DocStatus
}

/** 从文档根行读三键（tags 已归一化；status 含 archived） */
export function readVaultDocMeta(doc: BlockRow): VaultDocMeta {
  return {
    tags: readTags(doc),
    aiExclude: readAiExclude(doc),
    status: readDocStatus(doc),
  }
}

/**
 * 元数据指纹：sha256(JSON[tags, ai_exclude, status])。
 * 写回回声判定用它补齐 `doc_updated_at` 的盲区 —— tags / ai_exclude 走
 * `updateBlock(..., touchUpdatedAt: false)`，`doc.updated_at` 不变，
 * 只看时间戳会把真实元数据编辑误判成 ingest 回声而跳过写回。
 */
export function vaultMetaHash(doc: BlockRow): string {
  const meta = readVaultDocMeta(doc)
  return sha256Hex(JSON.stringify([meta.tags, meta.aiExclude, meta.status]))
}

/**
 * 文件侧声明的状态 → 文档应有的状态。
 * - 文件写了 `notefast_status: inbox | note | archived` → 文件为准（三个状态都能表达）
 * - 文件没写 → 缺省 note，但**绝不**把 archived 降级：老文件没有这个键，
 *   一次正文编辑就把归档文档静默拉回 note 是更坏的结果
 */
export function desiredStatusFromFile(
  fromFile: 'inbox' | 'note' | 'archived' | undefined,
  current: DocStatus,
): DocStatus {
  if (fromFile === 'inbox' || fromFile === 'note' || fromFile === 'archived') return fromFile
  return current === 'archived' ? 'archived' : 'note'
}

/**
 * 状态升级（inbox / archived → note）要不要重新抽实体与链。
 * 与 `PATCH /docs/:id/status` 的级联一致：文件也是用户操作，不该比 API 少做一步。
 * （archived → note 只能由 API 触发，但把判定收在一处更不容易走偏。）
 */
export function needsReanalyzeOnStatusChange(oldStatus: DocStatus, newStatus: DocStatus): boolean {
  return newStatus === 'note' && (oldStatus === 'inbox' || oldStatus === 'archived')
}
