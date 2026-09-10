/**
 * 实例数据目录 + Markdown 影子副本开关 + 当前模式（RFC 0005 U-1）
 *
 * - GET /api/v1/instance
 * - PUT /api/v1/instance  { shadow_markdown_enabled }
 *
 * `mode` / `vault_root` 让 Web 在任何模式下都能显示「数据来源」，
 * 不再靠 `/vault/status` 是否 404 来推断——vault 入口因此可以常显。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { applyShadowConfig, publicInstanceView } from '../services/shadowMarkdown'
import { getDb } from '../db'
import { WELCOME_DOC_TAG } from '../services/welcomeSeed'

/**
 * db 模式下的活文档数（引导页用；vault 模式不查）。
 * **不含欢迎文档**：新库里那份引导笔记是引擎自己种的，它不代表「用户以前有数据」，
 * 否则每个新装的 db 模式实例都会被当成 0.90 之前的老库（RFC 0006）。
 */
function liveDocCount(): number {
  try {
    const row = getDb()
      .query(
        `SELECT count(*) AS c FROM blocks
          WHERE type = 'document' AND is_deleted = 0
            AND NOT EXISTS (
              SELECT 1 FROM json_each(blocks.tags) WHERE value = ?
            )`,
      )
      .get(WELCOME_DOC_TAG) as { c: number }
    return row.c
  } catch {
    return 0
  }
}

/** 当前实例的数据权威所在：`db` = SQLite，`vault` = 用户文件夹 */
export interface InstanceModeView {
  mode: 'db' | 'vault'
  /** 仅 vault 模式有值：vault 根目录绝对路径 */
  vault_root: string | null
  /**
   * db 模式下的活文档数（RFC 0006：vault 是唯一形态，db 模式只在两种情况下存在——
   * 0.90 之前建的旧库有数据，或新装还没指定文件夹；前端据此给不同的引导）。
   * 由路由层补齐（`view()`），调用方不必自己查。
   */
  db_doc_count?: number
}

export function createInstanceRouter(getModeView: () => InstanceModeView): Hono {
  const instance = new Hono()

  const view = (): Record<string, unknown> => {
    const mode = getModeView()
    return {
      ...publicInstanceView(),
      ...mode,
      db_doc_count: mode.mode === 'db' ? liveDocCount() : 0,
    }
  }

  instance.get('/', (c) => c.json(view()))

  instance.put(
    '/',
    zValidator('json', z.object({
      shadow_markdown_enabled: z.boolean(),
    })),
    (c) => {
      const body = c.req.valid('json')
      applyShadowConfig({ enabled: body.shadow_markdown_enabled })
      return c.json(view())
    },
  )

  return instance
}

export default createInstanceRouter
