/**
 * 文档级向量索引作业
 *
 * 大文档 import/create 后：批处理 embed（BATCH=20）+ 全局限流，暴露进度/耗时/ETA。
 * 单块 afterCreate/Update 仍走 indexBlock（content_hash 可跳过）。
 */

import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { indexBlockBatch } from './indexer'

export type IndexJobState = 'pending' | 'running' | 'ready' | 'partial' | 'failed'

export interface IndexJob {
  id: string
  doc_id: string
  total_blocks: number
  done: number
  skipped: number
  errors: number
  state: IndexJobState
  started_at: string | null
  finished_at: string | null
  elapsed_ms: number
  eta_ms: number | null
  error: string | null
}

const BATCH = 20
/** 同时跑的文档索引作业数 */
const MAX_CONCURRENT_JOBS = 1
/** 批与批之间最小间隔，避免打爆 embedding API */
const BATCH_GAP_MS = 50
/** 终态（ready/partial/failed）作业保留上限：jobs Map 只增不减会内存单调增长，
 * 每次 schedule 后淘汰最老的终态作业（pending/running 永不淘汰） */
const MAX_FINISHED_JOBS = 100

const jobs = new Map<string, IndexJob>()
const queue: string[] = []
let activeCount = 0
/** 全局暂停：不启动新作业；正在跑的作业在当前批次结束后退回队列头部 */
let queuePaused = false

type InternalJob = IndexJob & { _blockIds?: string[]; _offset?: number }

/** 淘汰最老的终态作业（Map 迭代按插入序 = 创建序） */
function pruneFinishedJobs(): void {
  let finished = 0
  for (const job of jobs.values()) {
    if (job.state !== 'pending' && job.state !== 'running') finished++
  }
  let toDelete = finished - MAX_FINISHED_JOBS
  if (toDelete <= 0) return
  for (const [id, job] of jobs) {
    if (toDelete <= 0) break
    if (job.state === 'pending' || job.state === 'running') continue
    jobs.delete(id)
    toDelete--
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function recomputeTiming(job: IndexJob): void {
  if (!job.started_at) {
    job.elapsed_ms = 0
    job.eta_ms = null
    return
  }
  const started = Date.parse(job.started_at)
  job.elapsed_ms = Math.max(0, Date.now() - started)
  const processed = job.done + job.skipped + job.errors
  const remaining = Math.max(0, job.total_blocks - processed)
  if (processed > 0 && remaining > 0 && job.elapsed_ms > 0) {
    const per = job.elapsed_ms / processed
    job.eta_ms = Math.round(per * remaining)
  } else {
    job.eta_ms = remaining === 0 ? 0 : null
  }
}

function finalizeState(job: IndexJob): void {
  recomputeTiming(job)
  job.finished_at = nowIso()
  if (job.errors > 0 && job.done + job.skipped === 0) {
    job.state = 'failed'
  } else if (job.errors > 0) {
    job.state = 'partial'
  } else {
    job.state = 'ready'
  }
}

function yieldForPause(job: InternalJob, jobId: string, offset: number): boolean {
  if (!queuePaused) return false
  job._offset = offset
  job.state = 'pending'
  recomputeTiming(job)
  if (!queue.includes(jobId)) queue.unshift(jobId)
  return true
}

async function runJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId) as InternalJob | undefined
  if (!job) return

  job.state = 'running'
  if (!job.started_at) job.started_at = nowIso()
  recomputeTiming(job)

  if (!hasRuntime() || !getRuntime().hasEmbedding()) {
    job.error = 'Embedding 未配置'
    job.state = 'failed'
    job.finished_at = nowIso()
    recomputeTiming(job)
    return
  }

  const blockIds = job._blockIds ?? []
  let paused = false
  try {
    for (let offset = job._offset ?? 0; offset < blockIds.length; offset += BATCH) {
      // 被更新的作业 supersede 后 state 已置 failed：直接终止循环，
      // 不调 finalizeState（避免把 failed 覆盖成 ready/partial）
      if (job.state !== 'running') return
      if (yieldForPause(job, jobId, offset)) {
        paused = true
        return
      }
      const batch = blockIds.slice(offset, offset + BATCH)
      const result = await indexBlockBatch(batch)
      job.done += result.indexed
      job.skipped += result.skipped
      job.errors += result.errors
      job._offset = offset + BATCH
      recomputeTiming(job)
      if (offset + BATCH < blockIds.length && BATCH_GAP_MS > 0) {
        await new Promise((r) => setTimeout(r, BATCH_GAP_MS))
      }
    }
    finalizeState(job)
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e)
    job.state = 'failed'
    job.finished_at = nowIso()
    recomputeTiming(job)
  } finally {
    if (!paused) {
      delete job._blockIds
      delete job._offset
    }
  }
}

function pump(): void {
  if (queuePaused) return
  while (activeCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const id = queue.shift()!
    const job = jobs.get(id)
    if (!job || job.state !== 'pending') continue
    activeCount++
    void runJob(id).finally(() => {
      activeCount--
      pump()
    })
  }
}

export function isIndexQueuePaused(): boolean {
  return queuePaused
}

/** 暂停队列。正在跑的作业在当前批次结束后退回队首。 */
export function pauseIndexQueue(): void {
  queuePaused = true
}

/** 继续队列。 */
export function resumeIndexQueue(): void {
  if (!queuePaused) {
    pump()
    return
  }
  queuePaused = false
  pump()
}

/**
 * 为文档调度索引作业。若 embedding 未启用则返回 null。
 * blockIds 为空时立即 ready。
 */
export function scheduleDocIndex(
  docId: string,
  blockIds: string[],
  opts?: { ignoreAutoIndex?: boolean },
): IndexJob | null {
  if (!hasRuntime() || !getRuntime().hasEmbedding()) return null
  const cfg = getRuntime().status().config
  if (!opts?.ignoreAutoIndex && !cfg.autoIndex) return null

  const ids = [...new Set(blockIds.filter(Boolean))]
  const jobId = crypto.randomUUID()
  const job: InternalJob = {
    id: jobId,
    doc_id: docId,
    total_blocks: ids.length,
    done: 0,
    skipped: 0,
    errors: 0,
    state: ids.length === 0 ? 'ready' : 'pending',
    started_at: ids.length === 0 ? nowIso() : null,
    finished_at: ids.length === 0 ? nowIso() : null,
    elapsed_ms: 0,
    eta_ms: ids.length === 0 ? 0 : null,
    error: null,
    _blockIds: ids,
    _offset: 0,
  }
  jobs.set(jobId, job)
  pruneFinishedJobs()

  // 同文档旧未完成作业标记为 superseded（保留查询，但不抢进度）
  for (const [id, existing] of jobs) {
    if (id === jobId) continue
    if (existing.doc_id === docId && (existing.state === 'pending' || existing.state === 'running')) {
      existing.state = 'failed'
      existing.error = '被更新的索引作业取代'
      existing.finished_at = nowIso()
      recomputeTiming(existing)
    }
  }

  if (ids.length === 0) return publicJob(job)
  queue.push(jobId)
  pump()
  return publicJob(job)
}

function publicJob(job: IndexJob): IndexJob {
  recomputeTiming(job)
  return {
    id: job.id,
    doc_id: job.doc_id,
    total_blocks: job.total_blocks,
    done: job.done,
    skipped: job.skipped,
    errors: job.errors,
    state: job.state,
    started_at: job.started_at,
    finished_at: job.finished_at,
    elapsed_ms: job.elapsed_ms,
    eta_ms: job.eta_ms,
    error: job.error,
  }
}

export function getIndexJob(jobId: string): IndexJob | null {
  const job = jobs.get(jobId)
  return job ? publicJob(job) : null
}

/** 某文档最新作业（按创建顺序：Map 插入序，取最后匹配） */
export function getLatestIndexJobForDoc(docId: string): IndexJob | null {
  let latest: IndexJob | null = null
  for (const job of jobs.values()) {
    if (job.doc_id === docId) latest = job
  }
  return latest ? publicJob(latest) : null
}

export interface IndexJobSummary {
  /** 排队中（尚未开始）的作业数 */
  pending: number
  /** 正在运行的作业数（并发上限 1） */
  running: number
  /** 已完成（ready/partial）的作业数 */
  ready: number
  /** 失败作业数（含 superseded） */
  failed: number
  /** 当前正在跑的作业（含实时进度）；无则 null */
  active: IndexJob | null
  /** 最近完成的作业（按结束时间倒序，最多 5 条） */
  recent: IndexJob[]
  /** 会话内累计已索引块数 */
  indexedBlocks: number
  /** 全局暂停：排队作业不启动 */
  paused: boolean
}

/**
 * 增量索引作业汇总（设置页语义索引面板用）。
 * 作业在内存 Map：只有当前进程内的可见（结果已持久化，进度是瞬态显示）。
 */
export function getIndexJobSummary(): IndexJobSummary {
  let pending = 0
  let running = 0
  let ready = 0
  let failed = 0
  let indexedBlocks = 0
  let active: IndexJob | null = null
  const recent: IndexJob[] = []
  for (const job of jobs.values()) {
    recomputeTiming(job)
    indexedBlocks += job.done
    if (job.state === 'pending') {
      pending++
    } else if (job.state === 'running') {
      running++
      if (!active) active = publicJob(job)
    } else if (job.state === 'ready' || job.state === 'partial') {
      ready++
      recent.push(publicJob(job))
    } else if (job.state === 'failed') {
      failed++
      // superseded（被更新的作业取代）不进 recent，避免噪音
      if (job.error !== '被更新的索引作业取代') recent.push(publicJob(job))
    }
  }
  recent.sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''))
  return {
    pending,
    running,
    ready,
    failed,
    active,
    recent: recent.slice(0, 5),
    indexedBlocks,
    paused: queuePaused,
  }
}

/** 测试用：清空作业表 */
export function _resetIndexJobsForTests(): void {
  jobs.clear()
  queue.length = 0
  activeCount = 0
  queuePaused = false
}
