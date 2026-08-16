/**
 * 「导入到 NoteFast」HTTP client。
 *
 * POST {noteFastUrl}/api/v1/import/markdown，body = ImportPayload：
 * - source: { provider: 'note-fast-editor', external_id: <abs path> }
 *   复用 server 端现有 source dedup（findDocIdBySource）：同一文件重复导入返回既有文档。
 * - Authorization: Bearer <token>（免鉴权本地实例 token 为空，不带头）。
 */

import type { EditorSettings, ImportPayload } from '@notefast/shared'

export interface ImportResult {
  docId: string
  deduplicated: boolean
}

/** 校验并归一化 NoteFast base URL（去尾斜杠） */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** 对设置已配置的 NoteFast 实例发起导入；未配置返回错误码 */
export async function importToNoteFast(
  settings: EditorSettings,
  payload: ImportPayload,
): Promise<ImportResult> {
  const base = normalizeBaseUrl(settings.noteFastUrl)
  if (!base) {
    throw new Error('not_configured')
  }

  const res = await fetch(`${base}/api/v1/import/markdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.apiToken ? { Authorization: `Bearer ${settings.apiToken}` } : {}),
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    let code = 'request_failed'
    let message = `导入失败（HTTP ${res.status}）`
    try {
      const body = await res.json()
      if (typeof body?.error === 'string') code = body.error
      if (typeof body?.message === 'string') message = body.message
    } catch {
      /* 非 JSON 错误体，保持默认 message */
    }
    const err = new Error(message) as Error & { code?: string }
    err.code = code
    throw err
  }

  const body = (await res.json()) as { doc?: { id?: string }; deduplicated?: boolean }
  if (!body.doc?.id) {
    throw new Error('导入响应缺少文档 ID')
  }
  return { docId: body.doc.id, deduplicated: Boolean(body.deduplicated) }
}
