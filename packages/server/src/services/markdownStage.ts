/**
 * Markdown 分块暂存（MCP 大文件导入）
 *
 * Agent 把本地文件按块 stage，再 create_doc_from_file(upload_id)——
 * 正文字节不经单次 LLM 生成整段 tool 参数，避免截断/换行丢失。
 * 进程内 Map + TTL；重启丢失（可接受：未 finalize 的导入作废）。
 */

const TTL_MS = 30 * 60 * 1000
/** 与 importMarkdownSchema / createDocSchema 上限对齐 */
export const MAX_MARKDOWN_IMPORT_BYTES = 5_000_000
/** 单次 chunk 上限，迫使大文件多分几次（降低单次 tool 参数体积） */
export const MAX_STAGE_CHUNK_BYTES = 64 * 1024

interface StageEntry {
  parts: string[]
  size: number
  createdAt: number
  updatedAt: number
}

const stages = new Map<string, StageEntry>()

function sweepExpired(now = Date.now()): void {
  for (const [id, s] of stages) {
    if (now - s.updatedAt > TTL_MS) stages.delete(id)
  }
}

export class StageError extends Error {
  constructor(
    message: string,
    public code: 'invalid_params' | 'not_found' = 'invalid_params',
  ) {
    super(message)
    this.name = 'StageError'
  }
}

export function stageMarkdownChunk(chunk: string, uploadId?: string): { upload_id: string; size: number } {
  sweepExpired()
  if (typeof chunk !== 'string' || chunk.length === 0) {
    throw new StageError('chunk 不能为空')
  }
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (chunkBytes > MAX_STAGE_CHUNK_BYTES) {
    throw new StageError(`单次 chunk 不得超过 ${MAX_STAGE_CHUNK_BYTES} 字节，请拆分后上传`)
  }

  const now = Date.now()
  let id = uploadId?.trim() || ''
  let entry: StageEntry | undefined

  if (id) {
    entry = stages.get(id)
    if (!entry) throw new StageError(`upload_id 不存在或已过期：${id}`, 'not_found')
    if (now - entry.updatedAt > TTL_MS) {
      stages.delete(id)
      throw new StageError(`upload_id 已过期：${id}`, 'not_found')
    }
  } else {
    id = crypto.randomUUID()
    entry = { parts: [], size: 0, createdAt: now, updatedAt: now }
    stages.set(id, entry)
  }

  if (entry.size + chunkBytes > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new StageError(`合计内容不得超过 ${MAX_MARKDOWN_IMPORT_BYTES} 字节`)
  }

  entry.parts.push(chunk)
  entry.size += chunkBytes
  entry.updatedAt = now
  return { upload_id: id, size: entry.size }
}

/** 取出并删除暂存正文；不存在返回 null */
export function takeStagedMarkdown(uploadId: string): string | null {
  sweepExpired()
  const entry = stages.get(uploadId)
  if (!entry) return null
  stages.delete(uploadId)
  return entry.parts.join('')
}

export function discardStagedMarkdown(uploadId: string): boolean {
  return stages.delete(uploadId)
}

/** 测试用：清空全部暂存 */
export function _resetMarkdownStagesForTests(): void {
  stages.clear()
}
