/**
 * 实体词典 API（实体校准层）
 *
 * - GET  /api/v1/term-dict            当前词典（原始条目 + 统计）
 * - PUT  /api/v1/term-dict            全量保存（zod 校验 + 语义校验），保存后
 *                                     自动 fire-and-forget 存量归并（reanalyzeDoc 同款语义）
 * - POST /api/v1/term-dict/rebuild    手动存量归并（幂等，返回归并/新建/kind 更新数）
 *
 * 词典是用户声明的校准规则：默认无文件 = 空词典 = 检索行为零变化（纯增强）。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  dictStats,
  getTermDict,
  rebuildDictEntities,
  saveTermDictToDisk,
} from '../termDict'

const termEntrySchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(200).optional(),
  kind: z.enum(['concept', 'person', 'tool', 'doc']).optional(),
  description: z.string().max(1000).optional(),
})

const termDictSchema = z.object({
  terms: z.array(termEntrySchema).max(2000),
})

const termDict = new Hono()

function dictPayload(saved?: number) {
  const d = getTermDict()
  const stats = dictStats()
  return {
    enabled: d.entries.length > 0,
    count: stats.entries,
    alias_count: stats.aliases,
    terms: d.entries.map((e) => ({
      name: e.name,
      aliases: e.aliases,
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.description ? { description: e.description } : {}),
    })),
    ...(saved !== undefined ? { saved } : {}),
  }
}

termDict.get('/', (c) => {
  return c.json(dictPayload())
})

termDict.put('/', zValidator('json', termDictSchema), (c) => {
  const { terms } = c.req.valid('json')
  let saved
  try {
    saved = saveTermDictToDisk(
      terms.map((t) => ({ name: t.name, aliases: t.aliases ?? [], ...(t.kind ? { kind: t.kind } : {}), ...(t.description ? { description: t.description } : {}) })),
    )
  } catch (e) {
    return c.json({ error: 'bad_request', message: e instanceof Error ? e.message : String(e) }, 400)
  }
  // 存量归并随保存执行（幂等；也可手动 POST /rebuild 重跑）
  try {
    rebuildDictEntities()
  } catch (e) {
    console.error('[term-dict] auto rebuild failed:', e)
  }
  return c.json(dictPayload(saved.entries.length))
})

termDict.post('/rebuild', (c) => {
  const result = rebuildDictEntities()
  return c.json({ ...result })
})

export default termDict
