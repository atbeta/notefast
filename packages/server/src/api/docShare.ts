/**
 * 文档分享路由（/api/v1/docs/:id/share）——从 api/docs.ts 拆出。
 *
 * 独立 shares 表：开关不触发 updated_at / hooks / 索引 / change feed。
 * 允许分享 inbox / archived 文档（显式用户行为覆盖默认过滤）；
 * ai_exclude 文档也可分享，但首次开启需 confirm_ai_exclude 显式确认（见下）。
 * 有效期：默认永不过期（Notion 同款），可选 1/7/30 天；过期 = 未分享（惰性清理）。
 */

import type { Hono } from 'hono'
import { z } from 'zod'
import { rowToBlock } from '@notefast/core'
import { getDb } from '../db'
import { getLiveDocById } from '../store/blocks'
import { getShareByDocId, createShare, deleteShare, setShareExpiry } from '../store/shares'
import { auditDocAction, fireDocAfterShare, fireDocAfterShareRevoked } from '../services/hooks'
import { readDocAiExclude } from '../ai/aiExcludeQuery'

const sharePutSchema = z.object({
  expires_in_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullish(),
  /** 对 ai_exclude 文档首次开启分享时的显式确认（防误触外泄） */
  confirm_ai_exclude: z.boolean().optional(),
})

export function registerShareRoutes(docs: Hono): void {
  docs.get('/:id/share', (c) => {
    const db = getDb()
    const id = c.req.param('id')

    if (!getLiveDocById(db, id)) {
      return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
    }

    const share = getShareByDocId(db, id)
    return c.json(share
      ? {
          shared: true,
          token: share.token,
          path: `/s/${share.token}`,
          created_at: share.created_at,
          expires_at: share.expires_at,
        }
      : { shared: false })
  })

  docs.put('/:id/share', async (c) => {
    const db = getDb()
    const id = c.req.param('id')

    if (!getLiveDocById(db, id)) {
      return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
    }

    // body 可选（空 body = {}）；仅 expires_in_days 一个字段，手工校验
    const rawBody = await c.req.json().catch(() => ({}))
    const parsed = sharePutSchema.safeParse(rawBody)
    if (!parsed.success) {
      return c.json({ error: 'bad_request', message: 'expires_in_days 只接受 1 / 7 / 30 / null' }, 400)
    }

    const expiryDays = parsed.data.expires_in_days

    // Guardrail：对 ai_exclude 文档首次开启公开分享需要显式确认。
    // 「对 AI 隐藏」不等于「不能分享」（显式用户行为仍可覆盖），但公开链接
    // 对任何持有者裸读全文、默认永不过期，误触代价高，所以服务端强制二次确认。
    // 已开启的 PUT（仅调整有效期，无新增暴露面）不重复要求确认。
    if (
      parsed.data.confirm_ai_exclude !== true &&
      !getShareByDocId(db, id) &&
      readDocAiExclude(id) === true
    ) {
      return c.json({
        error: 'ai_exclude_share_needs_confirm',
        message: '该文档已标记「对 AI 隐藏」。开启公开分享后，任何拿到链接的人无需登录即可阅读全文；确认仍要分享请带 confirm_ai_exclude: true 重试',
      }, 409)
    }

    // 幂等：已开启返回现有 token；带 expires_in_days 时以现在为起点调整有效期。
    // 事务包裹：开启 + 调有效期两步写入对并发 PUT 原子（createShare 内部 ON CONFLICT 兜底）
    const share = db.transaction(() => {
      const created = createShare(db, id)
      return expiryDays !== undefined ? setShareExpiry(db, id, expiryDays)! : created
    })()
    const docRow2 = getLiveDocById(db, id)
    if (docRow2) {
      fireDocAfterShare({
        doc: rowToBlock(docRow2),
        meta: { token: share.token, path: `/s/${share.token}`, expires_at: share.expires_at },
      })
    }
    auditDocAction('doc.shared', id, { token: share.token, expires_at: share.expires_at })
    return c.json({
      token: share.token,
      path: `/s/${share.token}`,
      created_at: share.created_at,
      expires_at: share.expires_at,
    })
  })

  docs.delete('/:id/share', (c) => {
    const db = getDb()
    const id = c.req.param('id')

    if (!getLiveDocById(db, id)) {
      return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
    }

    // 幂等：本就没开启也返回成功；关闭后旧链接立即 404，重开生成全新 token
    const existing = getShareByDocId(db, id)
    deleteShare(db, id)
    const docRow3 = getLiveDocById(db, id)
    if (docRow3 && existing) {
      fireDocAfterShareRevoked({
        doc: rowToBlock(docRow3),
        meta: { token: existing.token },
      })
    }
    if (existing) {
      auditDocAction('doc.share_revoked', id, { token: existing.token })
    }
    return c.json({ deleted: true })
  })
}
