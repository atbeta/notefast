/**
 * 实例数据目录 + Markdown 影子副本开关
 *
 * - GET /api/v1/instance
 * - PUT /api/v1/instance  { shadow_markdown_enabled, shadow_path_mode? }
 *
 * `shadow_path_mode`（RFC 0007 D2）决定投影路径归谁：
 * `system` = 由标题 / 标签派生（既有行为），`user` = 首次取默认名后以磁盘为准。
 * 两个字段都可选，未传的沿用当前值——只传 `shadow_markdown_enabled` 的老调用方不受影响。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { applyShadowConfig, publicInstanceView } from '../services/shadowMarkdown'

const instance = new Hono()

instance.get('/', (c) => c.json(publicInstanceView()))

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
    return c.json(publicInstanceView())
  },
)

export default instance
