/**
 * 轮询文档向量索引作业，用于创建/导入后的进度感知。
 */

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

export function formatIndexProgress(job: IndexJob): string {
  const processed = job.done + job.skipped + job.errors
  const total = job.total_blocks
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100
  const eta =
    job.eta_ms != null && job.eta_ms > 0
      ? ` · 约 ${(job.eta_ms / 1000).toFixed(1)}s`
      : ''
  if (job.state === 'ready') {
    return `索引完成 · ${total} 块 · ${(job.elapsed_ms / 1000).toFixed(1)}s`
  }
  if (job.state === 'partial') {
    return `索引部分完成 · ${job.done}/${total} 成功 · ${job.errors} 失败 · ${(job.elapsed_ms / 1000).toFixed(1)}s`
  }
  if (job.state === 'failed') {
    return `索引失败${job.error ? `：${job.error}` : ''}`
  }
  return `正在向量化 ${processed}/${total}（${pct}%）${eta}`
}

export async function fetchIndexJob(jobId: string): Promise<IndexJob> {
  return request<IndexJob>(`/ai/index/jobs/${jobId}`)
}

export async function fetchLatestIndexJobForDoc(docId: string): Promise<IndexJob | null> {
  try {
    return await request<IndexJob>(`/ai/index/jobs?doc_id=${encodeURIComponent(docId)}`)
  } catch {
    return null
  }
}

/**
 * 轮询直到作业结束；每次更新调用 onUpdate。
 * 返回最终 job；超时或中止时返回最后一次快照。
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
  const timeoutMs = opts.timeoutMs ?? 120_000
  const start = Date.now()
  let last = await fetchIndexJob(jobId)
  opts.onUpdate?.(last)

  while (last.state === 'pending' || last.state === 'running') {
    if (opts.signal?.aborted) return last
    if (Date.now() - start > timeoutMs) return last
    await new Promise((r) => setTimeout(r, intervalMs))
    if (opts.signal?.aborted) return last
    last = await fetchIndexJob(jobId)
    opts.onUpdate?.(last)
  }
  return last
}
