/**
 * 实例数据目录 + Markdown 影子副本开关
 *
 * - GET /api/v1/instance
 * - PUT /api/v1/instance  { shadow_markdown_enabled }
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
    shadow_markdown_enabled: z.boolean(),
  })),
  (c) => {
    const body = c.req.valid('json')
    applyShadowConfig({ enabled: body.shadow_markdown_enabled })
    return c.json(publicInstanceView())
  },
)

export default instance
