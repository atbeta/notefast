import { useEffect, useState } from 'react'
import { api } from './useAPI'

export interface ZipImportStatus {
  running: boolean
  phase: 'idle' | 'parsing' | 'media' | 'docs' | 'hooks' | 'done'
  total_docs: number
  done_docs: number
  imported: number
  skipped: number
  failed: number
  media_imported: number
  error: string | null
}

const POLL_MS = 800

/** POST /import/zip 进行中轮询 GET /import/zip-status */
export function useZipImportProgress(active: boolean): ZipImportStatus | null {
  const [status, setStatus] = useState<ZipImportStatus | null>(null)

  useEffect(() => {
    if (!active) {
      setStatus(null)
      return
    }
    let cancelled = false
    const tick = () => {
      void api.get<ZipImportStatus>('/import/zip-status').then((s) => {
        if (!cancelled) setStatus(s)
      }).catch(() => {})
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active])

  return status
}

export function zipImportProgressLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  status: ZipImportStatus | null,
  keys: { idle: string; progress: string; media: string; hooks: string },
): string {
  if (!status || status.phase === 'idle' || status.phase === 'parsing') return t(keys.idle)
  if (status.phase === 'media') return t(keys.media, { n: status.media_imported })
  if (status.phase === 'hooks') return t(keys.hooks)
  if (status.total_docs > 0) return t(keys.progress, { done: status.done_docs, total: status.total_docs })
  return t(keys.idle)
}
