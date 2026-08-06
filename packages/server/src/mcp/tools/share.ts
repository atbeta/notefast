/**
 * MCP 工具 —— 文档分享（公开只读链接）组
 *
 * - notefast_share_doc(doc_id, expires_in_days?)   开启分享（幂等）；已开启时
 *   携带 expires_in_days 则以现在为起点调整有效期
 * - notefast_get_share(doc_id)                     查询分享状态（未开启返回 shared: false）
 * - notefast_unshare_doc(doc_id)                   关闭分享（幂等）；旧链接立即失效，
 *   重新开启生成全新 token
 *
 * 语义与 REST（GET/PUT/DELETE /docs/:id/share）完全对齐：仅活文档、允许
 * inbox/archived、expires_in_days 仅 1/7/30/null、hooks 与审计事件一致。
 *
 * 与 REST 的唯一差异：ai_exclude 文档一律 forbidden，不提供 confirm_ai_exclude
 * 通道——显式确认流程是给 Web UI 里的人类用户的，AI agent 不应能把「对 AI 隐藏」
 * 的文档变成公开链接（与 MCP 既有守卫 denyAiExcludedDoc 一致）。
 *
 * 不触发 scheduleSyncNow：shares 不进 change feed / 多端同步，是纯本地状态。
 */

import { z } from 'zod'
import { rowToBlock } from '@notefast/core'
import { getDb } from '../../db'
import { getLiveDocById } from '../../store/blocks'
import {
  createShare,
  deleteShare,
  getShareByDocId,
  setShareExpiry,
  type ShareRow,
} from '../../store/shares'
import { fireDocAfterShare, fireDocAfterShareRevoked } from '../../services/hooks'
import { emitAppEvent } from '../../events'
import { denyAiExcludedDoc, toText, toolError, type ToolContext } from './helpers'

function sharePayload(share: ShareRow) {
  return {
    shared: true,
    token: share.token,
    path: `/s/${share.token}`,
    created_at: share.created_at,
    expires_at: share.expires_at,
  }
}

/** 文档存在性 + ai_exclude 守卫（三者共用）；通过返回 null */
function guardDoc(docId: string) {
  const db = getDb()
  if (!getLiveDocById(db, docId)) {
    return toolError('not_found', `文档 ${docId} 不存在`, { doc_id: docId })
  }
  return denyAiExcludedDoc(docId)
}

export function registerShareTools(ctx: ToolContext): void {
  const { registerTool } = ctx

  registerTool(
    'notefast_share_doc',
    {
      description:
        '开启文档的公开只读分享链接（幂等：已开启则返回现有链接）。任何拿到链接的人无需登录即可阅读全文，请确认用户确实要公开这篇文档。关闭用 notefast_unshare_doc',
      inputSchema: {
        doc_id: z.string().min(1).describe('文档 ID'),
        expires_in_days: z
          .union([z.literal(1), z.literal(7), z.literal(30)])
          .nullable()
          .optional()
          .describe('有效期天数（1/7/30）；缺省或不传 = 不调整，null = 改为永不过期'),
      },
    },
    async ({ doc_id, expires_in_days }) => {
      const denied = guardDoc(doc_id)
      if (denied) return denied

      const db = getDb()
      // 与 REST 相同：开启 + 调有效期两步写入对并发原子（createShare 内部 ON CONFLICT 兜底）
      const share = db.transaction(() => {
        const created = createShare(db, doc_id)
        return expires_in_days !== undefined ? setShareExpiry(db, doc_id, expires_in_days)! : created
      })()

      const docRow = getLiveDocById(db, doc_id)
      if (docRow) {
        fireDocAfterShare({
          doc: rowToBlock(docRow),
          meta: { token: share.token, path: `/s/${share.token}`, expires_at: share.expires_at },
        })
      }
      emitAppEvent({
        source: 'mcp',
        actor: 'mcp',
        action: 'doc.shared',
        target: { type: 'doc', id: doc_id },
        outcome: 'success',
        fields: { token: share.token, expires_at: share.expires_at },
      })

      return { content: [toText(sharePayload(share))] }
    },
  )

  registerTool(
    'notefast_get_share',
    {
      description: '查询文档的公开分享状态；未开启返回 shared: false',
      inputSchema: {
        doc_id: z.string().min(1).describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const denied = guardDoc(doc_id)
      if (denied) return denied

      const share = getShareByDocId(getDb(), doc_id)
      return { content: [toText(share ? sharePayload(share) : { shared: false })] }
    },
  )

  registerTool(
    'notefast_unshare_doc',
    {
      description:
        '关闭文档的公开分享（幂等）。旧链接立即失效；重新开启会生成全新链接，旧链接不可恢复',
      inputSchema: {
        doc_id: z.string().min(1).describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const denied = guardDoc(doc_id)
      if (denied) return denied

      const db = getDb()
      const existing = getShareByDocId(db, doc_id)
      deleteShare(db, doc_id)

      if (existing) {
        const docRow = getLiveDocById(db, doc_id)
        if (docRow) {
          fireDocAfterShareRevoked({
            doc: rowToBlock(docRow),
            meta: { token: existing.token },
          })
        }
        emitAppEvent({
          source: 'mcp',
          actor: 'mcp',
          action: 'doc.share_revoked',
          target: { type: 'doc', id: doc_id },
          outcome: 'success',
          fields: { token: existing.token },
        })
      }

      return { content: [toText({ deleted: true })] }
    },
  )
}
