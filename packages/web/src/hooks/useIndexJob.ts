/**
 * 文档向量索引：作业进度 + 覆盖率快照 + 全局队列。
 * 作业在服务端内存，切文档/刷新后靠 GET /ai/index/docs/:id 的 SQLite 覆盖率兜底。
 */

import { useEffect, useState } from 'react'
import i18next from '../i18n'
import { request } from '../hooks/useAPI'

export interface IndexJob {
  id: string
  doc_id: string
  total_blocks: number
  done: number
  skipped: number
  errors: number
  state: 'pending' | 'running' | 'ready' | 'partial' | 'failed'
  started_at: string | null
  finished_at: string | null
  elapsed_ms: number
  eta_ms: number | null
  error: string | null
}

export type IndexSkipReason = 'ai_exclude' | 'inbox' | 'archived' | 'no_embedding' | 'auto_index_off'

export interface DocIndexState {
  skip_reason: IndexSkipReason | null
  job: IndexJob | null
  eligible: number
  indexed: number
  queue: { pending: number; running: number; paused: boolean }
}

export interface IndexJobSummary {
  pending: number
  running: number
  ready: number
  failed: number
  active: IndexJob | null
  recent: IndexJob[]
  indexedBlocks: number
  paused: boolean
}

export function isIndexJobActive(job: IndexJob | null | undefined): boolean {
  return job?.state === 'pending' || job?.state === 'running'
}

export function formatIndexProgress(job: IndexJob, opts?: { paused?: boolean }): string {
  const processed = job.done + job.skipped + job.errors
  const total = job.total_blocks
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100
  const eta =
    job.eta_ms != null && job.eta_ms > 0
      ? i18next.t('indexJob.eta', { sec: (job.eta_ms / 1000).toFixed(1) })
      : ''
  if (job.state === 'ready') {
    return i18next.t('indexJob.ready', { total, elapsed: (job.elapsed_ms / 1000).toFixed(1) })
  }
  if (job.state === 'partial') {
    return i18next.t('indexJob.partial', {
      done: job.done,
      total,
      errors: job.errors,
      elapsed: (job.elapsed_ms / 1000).toFixed(1),
    })
  }
  if (job.state === 'failed') {
    return i18next.t('indexJob.failed', { error: job.error ?? '' })
  }
  if (opts?.paused) {
    return i18next.t('indexJob.paused', { processed, total, pct })
  }
  if (job.state === 'pending') {
    return i18next.t('indexJob.queued', { total })
  }
  return i18next.t('indexJob.progress', { processed, total, pct, eta })
}

export async function fetchIndexJob(jobId: string): Promise<IndexJob> {
  return request<IndexJob>(`/ai/index/jobs/${jobId}`)
}

export async function fetchDocIndexState(docId: string, signal?: AbortSignal): Promise<DocIndexState> {
  return request<DocIndexState>(`/ai/index/docs/${encodeURIComponent(docId)}`, { signal })
}

export async function startDocIndex(docId: string): Promise<DocIndexState & { index_job: IndexJob }> {
  return request<DocIndexState & { index_job: IndexJob }>(`/ai/index/docs/${encodeURIComponent(docId)}`, {
    method: 'POST',
    body: '{}',
  })
}

export async function fetchIndexJobSummary(): Promise<IndexJobSummary> {
  return request<IndexJobSummary>('/ai/index/jobs/summary')
}

export async function pauseIndexQueue(): Promise<IndexJobSummary> {
  return request<IndexJobSummary>('/ai/index/jobs/pause', { method: 'POST', body: '{}' })
}

export async function resumeIndexQueue(): Promise<IndexJobSummary> {
  return request<IndexJobSummary>('/ai/index/jobs/resume', { method: 'POST', body: '{}' })
}

export async function fillIndexGaps(): Promise<{ queued: number }> {
  return request<{ queued: number }>('/ai/index/gaps', { method: 'POST', body: '{}' })
}

export async function fetchLatestIndexJobForDoc(docId: string): Promise<IndexJob | null> {
  try {
    return await request<IndexJob>(`/ai/index/jobs?doc_id=${encodeURIComponent(docId)}`)
  } catch {
    return null
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError'
}

/**
 * 轮询直到作业结束；每次更新调用 onUpdate。
 * 默认不设短超时（长队列导入会超过 120s）。传入 timeoutMs 可截断。
 */
export async function pollIndexJob(
  jobId: string,
  opts: {
    onUpdate?: (job: IndexJob) => void
    intervalMs?: number
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<IndexJob> {
  const intervalMs = opts.intervalMs ?? 400
  const start = Date.now()
  let last = await fetchIndexJob(jobId)
  opts.onUpdate?.(last)

  while (last.state === 'pending' || last.state === 'running') {
    if (opts.signal?.aborted) return last
    if (opts.timeoutMs != null && Date.now() - start > opts.timeoutMs) return last
    await new Promise((r) => setTimeout(r, intervalMs))
    if (opts.signal?.aborted) return last
    last = await fetchIndexJob(jobId)
    opts.onUpdate?.(last)
  }
  return last
}

/** 按文档轮询覆盖率 + 作业，直到不再 pending/running。 */
export async function pollDocIndex(
  docId: string,
  opts: {
    onUpdate?: (state: DocIndexState) => void
    intervalMs?: number
    signal?: AbortSignal
  } = {},
): Promise<DocIndexState> {
  const intervalMs = opts.intervalMs ?? 500
  let last = await fetchDocIndexState(docId, opts.signal)
  opts.onUpdate?.(last)

  while (isIndexJobActive(last.job)) {
    if (opts.signal?.aborted) return last
    await new Promise((r) => setTimeout(r, intervalMs))
    if (opts.signal?.aborted) return last
    try {
      last = await fetchDocIndexState(docId, opts.signal)
    } catch (e) {
      if (isAbortError(e)) return last
      throw e
    }
    opts.onUpdate?.(last)
  }
  return last
}

/** 全局增量索引队列摘要；忙时 2s、空闲 4s。 */
export function useIndexJobSummary(): {
  summary: IndexJobSummary | null
  setSummary: (s: IndexJobSummary) => void
} {
  const [summary, setSummary] = useState<IndexJobSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const next = await fetchIndexJobSummary()
        if (!cancelled) setSummary(next)
      } catch {
        /* 离线时由 ServerOfflineBanner 负责 */
      }
    }
    void tick()
    const busy = Boolean(summary?.paused || (summary?.pending ?? 0) > 0 || (summary?.running ?? 0) > 0)
    const id = window.setInterval(() => void tick(), busy ? 2000 : 4000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [summary?.paused, summary?.pending, summary?.running])

  return { summary, setSummary }
}
