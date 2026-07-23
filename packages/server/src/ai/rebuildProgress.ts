/**
 * 全量向量重建进度（进程内）；供 GET /ai/index/status 合并展示。
 */

export interface RebuildProgress {
  processed: number
  total: number
  started_at: string
  elapsed_ms: number
  eta_ms: number | null
}

let progress: RebuildProgress | null = null

export function beginRebuildProgress(total: number): void {
  progress = {
    processed: 0,
    total,
    started_at: new Date().toISOString(),
    elapsed_ms: 0,
    eta_ms: null,
  }
}

export function bumpRebuildProgress(processed: number): void {
  if (!progress) return
  progress.processed = processed
  progress.elapsed_ms = Math.max(0, Date.now() - Date.parse(progress.started_at))
  const remaining = Math.max(0, progress.total - processed)
  if (processed > 0 && remaining > 0 && progress.elapsed_ms > 0) {
    progress.eta_ms = Math.round((progress.elapsed_ms / processed) * remaining)
  } else {
    progress.eta_ms = remaining === 0 ? 0 : null
  }
}

export function endRebuildProgress(): void {
  progress = null
}

export function getRebuildProgress(): RebuildProgress | null {
  if (!progress) return null
  return {
    ...progress,
    elapsed_ms: Math.max(0, Date.now() - Date.parse(progress.started_at)),
  }
}
