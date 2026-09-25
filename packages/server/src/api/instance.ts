/**
 * 实例数据目录 + Markdown 影子副本开关 + 投影状态
 *
 * - GET /api/v1/instance
 * - PUT /api/v1/instance  { shadow_markdown_enabled, shadow_path_mode? }
 *
 * `shadow_path_mode`（RFC 0007 D2）决定投影路径归谁：
 * `system` = 由标题 / 标签派生（既有行为），`user` = 首次取默认名后以磁盘为准。
 * 两个字段都可选，未传的沿用当前值——只传 `shadow_markdown_enabled` 的老调用方不受影响。
 *
 * `projection` 字段（RFC 0007 S3）报出投影状态，**扩展既有响应而不是新开命名空间**：
 * 新字段是加法，新命名空间会让契约面永久变大。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import { applyShadowConfig, getShadowConfig, getMarkdownDirAbs, publicInstanceView } from '../services/shadowMarkdown'
import { projectionStatus } from '../projection/status'

const instance = new Hono()

/** 取默认 notebook（单 Notebook 实例：按 sort / created_at 取第一本） */
function defaultNotebookId(): string | null {
  const row = getDb()
    .query('SELECT id FROM notebooks ORDER BY sort ASC, created_at ASC LIMIT 1')
    .get() as { id: string } | undefined
  return row?.id ?? null
}

function instanceView(): Record<string, unknown> {
  const base = publicInstanceView()
  const cfg = getShadowConfig()
  const notebookId = defaultNotebookId()
  return {
    ...base,
    projection: notebookId
      ? projectionStatus(getDb(), notebookId, {
          enabled: cfg.enabled,
          root: cfg.enabled ? getMarkdownDirAbs() : null,
        })
      : null,
  }
}

instance.get('/', (c) => c.json(instanceView()))

instance.put(
  '/',
  zValidator('json', z.object({
    shadow_markdown_enabled: z.boolean().optional(),
    shadow_path_mode: z.enum(['system', 'user']).optional(),
  })),
  (c) => {
    const body = c.req.valid('json')
    applyShadowConfig({
      enabled: body.shadow_markdown_enabled,
      pathMode: body.shadow_path_mode,
    })
    return c.json(instanceView())
  },
)

export default instance
