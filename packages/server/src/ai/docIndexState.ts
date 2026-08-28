/**
 * 文档向量索引快照：内存作业 + SQLite 覆盖率。
 * 作业表会 prune / 随进程消失，覆盖率用来在回来时仍能看出「未索引 / 部分 / 已索引」。
 */

import { readAiExclude, readDocStatus } from '@notefast/core'
import { getDb } from '../db'
import { getDocById } from '../store/blocks'
import { VECTOR_INDEX_VERSION } from './vectorStore'
import { currentEmbeddingFingerprint } from './indexer'
import {
  getIndexJobSummary,
  getLatestIndexJobForDoc,
  type IndexJob,
} from './indexJobs'
import { hasRuntime, getRuntime } from '../services/aiRuntime'

export type IndexSkipReason = 'ai_exclude' | 'inbox' | 'archived' | 'no_embedding' | 'auto_index_off'

export interface DocIndexState {
  skip_reason: IndexSkipReason | null
  job: IndexJob | null
  eligible: number
  indexed: number
  queue: { pending: number; running: number; paused: boolean }
}

export function getDocIndexState(docId: string): DocIndexState | null {
  const row = getDocById(getDb(), docId)
  if (!row) return null

  const summary = getIndexJobSummary()
  const queue = { pending: summary.pending, running: summary.running, paused: summary.paused }
  const job = getLatestIndexJobForDoc(docId)

  const embeddingOn = hasRuntime() && getRuntime().hasEmbedding()
  const autoIndex = embeddingOn && getRuntime().status().config.autoIndex
  const status = readDocStatus(row)
  const aiExclude = readAiExclude(row)

  let skip_reason: IndexSkipReason | null = null
  if (!embeddingOn) skip_reason = 'no_embedding'
  else if (status === 'inbox') skip_reason = 'inbox'
  else if (status === 'archived') skip_reason = 'archived'
  else if (aiExclude) skip_reason = 'ai_exclude'
  else if (!autoIndex && job?.state !== 'pending' && job?.state !== 'running') {
    skip_reason = 'auto_index_off'
  }

  const { eligible, indexed } = embeddingOn
    ? countCoverage(docId)
    : { eligible: 0, indexed: 0 }

  return { skip_reason, job, eligible, indexed, queue }
}

export interface NotebookIndexCoverage {
  /** 有正文、应对 AI 可见的笔记篇数（排除收集箱 / 归档 / ai_exclude / 空正文） */
  notes: number
  ready: number
  partial: number
  unindexed: number
}

export function getNotebookIndexCoverage(): NotebookIndexCoverage | null {
  if (!hasRuntime() || !getRuntime().hasEmbedding()) return null
  const rows = loadCoverageRows()
  if (!rows) return { notes: 0, ready: 0, partial: 0, unindexed: 0 }
  let ready = 0
  let partial = 0
  let unindexed = 0
  for (const row of rows) {
    if (row.indexed <= 0) unindexed++
    else if (row.indexed < row.eligible) partial++
    else ready++
  }
  return { notes: rows.length, ready, partial, unindexed }
}

/** 正文覆盖不足的笔记（设置页「补齐未索引」） */
export function listGapDocIds(): string[] {
  const rows = loadCoverageRows()
  if (!rows) return []
  return rows.filter((row) => row.indexed < row.eligible).map((row) => row.doc_id)
}

function loadCoverageRows(): Array<{ doc_id: string; eligible: number; indexed: number }> | null {
  const fingerprint = currentEmbeddingFingerprint()
  if (!fingerprint) return null
  const db = getDb()
  const indexedJoin = indexedCoverageJoin(fingerprint)
  return db.query(
    `SELECT e.doc_id AS doc_id, e.eligible AS eligible, COALESCE(i.indexed, 0) AS indexed
     FROM (
       SELECT b.root_id AS doc_id, count(*) AS eligible
       FROM blocks b
       JOIN blocks d ON d.id = b.root_id
       WHERE d.type = 'document' AND d.is_deleted = 0 AND d.status = 'note' AND d.ai_exclude = 0
         AND b.is_deleted = 0 AND b.type != 'document' AND length(trim(b.content)) > 0
       GROUP BY b.root_id
     ) e
     LEFT JOIN (
       SELECT b.root_id AS doc_id, count(*) AS indexed
       FROM blocks b
       JOIN blocks d ON d.id = b.root_id
       ${indexedJoin.sql}
       WHERE d.type = 'document' AND d.is_deleted = 0 AND d.status = 'note' AND d.ai_exclude = 0
         AND b.is_deleted = 0 AND b.type != 'document' AND length(trim(b.content)) > 0
       GROUP BY b.root_id
     ) i ON i.doc_id = e.doc_id`,
  ).all(...indexedJoin.params) as Array<{ doc_id: string; eligible: number; indexed: number }>
}

function countCoverage(docId: string): { eligible: number; indexed: number } {
  const fingerprint = currentEmbeddingFingerprint()
  const db = getDb()
  // 只计正文块：文档根（标题）会写进每个子块的「标题：」前缀，检索也不把根块当独立 chunk。
  // 把标题算进分母会让大量已索引笔记显示成 3/4。
  const eligible = (db.query(
    `SELECT count(*) AS n FROM blocks
     WHERE is_deleted = 0 AND root_id = ? AND type != 'document' AND length(trim(content)) > 0`,
  ).get(docId) as { n: number }).n
  if (!fingerprint || eligible === 0) return { eligible, indexed: 0 }
  const indexedJoin = indexedCoverageJoin(fingerprint)
  const indexed = (db.query(
    `SELECT count(*) AS n FROM blocks b
     ${indexedJoin.sql}
     WHERE b.is_deleted = 0 AND b.root_id = ? AND b.type != 'document'
       AND length(trim(b.content)) > 0`,
  ).get(...indexedJoin.params, docId) as { n: number }).n
  return { eligible, indexed }
}

/**
 * 覆盖率跟检索同一套权威：sqlite-vec 看当前 generation，json 看 block_vectors。
 * 换模型后旧指纹行不能算「已索引」，否则重建写进 sqlite-vec 后 UI 仍全是缺口。
 */
function indexedCoverageJoin(fingerprint: string): { sql: string; params: Array<string | number> } {
  const gen = activeSqliteVecGeneration(fingerprint)
  if (gen) {
    return {
      sql: 'JOIN vector_entries v ON v.block_id = b.id AND v.generation = ?',
      params: [gen],
    }
  }
  return {
    sql: 'JOIN block_vectors v ON v.block_id = b.id AND v.embedding_model = ? AND v.index_version = ?',
    params: [fingerprint, VECTOR_INDEX_VERSION],
  }
}

function activeSqliteVecGeneration(fingerprint: string): string | null {
  const row = getDb().query(
    `SELECT s.active_generation AS id
     FROM vector_store_state s
     JOIN vector_generations g ON g.id = s.active_generation
     WHERE s.id = 'default' AND s.active_backend = 'sqlite-vec'
       AND g.model_fingerprint = ?`,
  ).get(fingerprint) as { id: string | null } | undefined
  return row?.id ?? null
}
