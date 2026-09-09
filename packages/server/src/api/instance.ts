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

/** 当前实例的数据权威所在：`db` = SQLite，`vault` = 用户文件夹 */
export interface InstanceModeView {
  mode: 'db' | 'vault'
  /** 仅 vault 模式有值：vault 根目录绝对路径 */
  vault_root: string | null
}

export function createInstanceRouter(getModeView: () => InstanceModeView): Hono {
  const instance = new Hono()

  instance.get('/', (c) => c.json({ ...publicInstanceView(), ...getModeView() }))

  instance.put(
    '/',
    zValidator('json', z.object({
      shadow_markdown_enabled: z.boolean(),
    })),
    (c) => {
      const body = c.req.valid('json')
      applyShadowConfig({ enabled: body.shadow_markdown_enabled })
      return c.json({ ...publicInstanceView(), ...getModeView() })
    },
  )

  return instance
}

export default createInstanceRouter
