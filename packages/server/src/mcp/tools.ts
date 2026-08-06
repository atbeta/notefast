/**
 * MCP 工具注册入口
 *
 * 工具按域拆分到 tools/ 子目录（共享 helper 在 tools/helpers.ts）：
 * - docRead.ts   只读：search / get_doc / get_block / get_doc_tree /
 *                export_markdown / get_backlinks + 2 个 resource
 * - docWrite.ts  写入与列表：create_block / update_block / create_doc /
 *                stage_markdown / create_doc_from_file /
 *                list_docs / list_tags / set_doc_tags
 * - aiChat.ts    AI：semantic_search / suggest_title / chat / get_config
 * - autoLink.ts  AutoLink：run（高置信直接建链，无审核队列）
 * - share.ts     分享：share_doc / get_share / unshare_doc（语义对齐 REST，
 *                ai_exclude 文档一律 forbidden，无 confirm 通道）
 *
 * 调用方（mcp/server.ts）只依赖本文件的 registerMcpTools，签名不变。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../db'
import { createRegisterTool, type ToolContext } from './tools/helpers'
import { registerDocReadTools } from './tools/docRead'
import { registerDocWriteTools } from './tools/docWrite'
import { registerAiChatTools } from './tools/aiChat'
import { registerAutoLinkTools } from './tools/autoLink'
import { registerEntityTools } from './tools/entityTools'
import { registerShareTools } from './tools/share'

export function registerMcpTools(server: McpServer, notebookId: string): void {
  const ctx: ToolContext = {
    server,
    db: getDb(),
    notebookId,
    // 统一在注册处包一层日志，避免逐个 handler 手动包裹
    registerTool: createRegisterTool(server),
  }

  registerDocReadTools(ctx)
  registerDocWriteTools(ctx)
  registerAiChatTools(ctx)
  registerAutoLinkTools(ctx)
  registerEntityTools(ctx)
  registerShareTools(ctx)
}
