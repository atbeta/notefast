/**
 * MCP 工具 —— AI 组
 *
 * notefast_semantic_search / suggest_title / chat / get_config。
 * get_config 原先用旧 server.tool() API 注册，拆分时统一为 registerTool 风格
 * （schema 与描述保持不变）。
 */

import { z } from 'zod'
import {
  suggestTitle,
  type ChatMessage,
  type LLMProvider,
} from '@notefast/core'
import { hasRuntime, getRuntime } from '../../services/aiRuntime'
import { getDocById } from '../../store/blocks'
import { semanticSearch } from '../../ai/indexer'
import { runChatSync } from '../../ai/chat'
import {
  NOT_CONFIGURED_HINT,
  denyAiExcludedDoc,
  isValidIsoDate,
  toText,
  toolError,
  type ToolContext,
} from './helpers'

export function registerAiChatTools(ctx: ToolContext): void {
  const { db, registerTool } = ctx

  registerTool(
    'notefast_semantic_search',
    {
      description: '语义搜索知识库（需配置 AI Provider），用自然语言查找最相关的 block',
      inputSchema: {
        query: z.string().min(1).max(1000).describe('自然语言查询，如 "关于 React 性能优化我写过什么"'),
        limit: z.number().int().min(1).max(100).optional().default(10).describe('最大返回数量'),
        notebook_id: z.string().optional().describe('限定笔记本 ID'),
      },
    },
    async ({ query, limit, notebook_id }) => {
      if (!hasRuntime() || !getRuntime().hasEmbedding()) {
        return toolError('not_configured', 'Embedding 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const r = getRuntime()
        const vector = await r.embedQuery(query)
        if (!vector) {
          return toolError('provider_error', r.status().embedding.lastError || 'embedding 返回空向量')
        }
        const hits = await semanticSearch(vector, limit ?? 10, notebook_id)
        return { content: [toText({ query, results: hits.length, hits })] }
      } catch (e) {
        return toolError('provider_error', e instanceof Error ? e.message : String(e), { fix_hint: '请检查 /settings 中的 Provider 配置' })
      }
    },
  )

  registerTool(
    'notefast_suggest_title',
    {
      description: '根据笔记内容 AI 生成标题和摘要',
      inputSchema: {
        content: z.string().describe('笔记正文内容'),
      },
    },
    async ({ content }) => {
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const r = getRuntime()
        const provider: LLMProvider = {
          name: 'notefast-runtime',
          chat: (msgs, opts) => r.chat(msgs, opts),
        }
        const result = await suggestTitle(provider, content)
        return { content: [toText(result)] }
      } catch (e) {
        return toolError('llm_error', e instanceof Error ? e.message : String(e))
      }
    },
  )

  registerTool(
    'notefast_chat',
    {
      description:
        '与用户知识库对话：FTS5 + 语义检索 + 可选 reranker，再交给 LLM 生成带 [n] 引用的回答。LLM 可在 agent loop 中调用 notefast_search_more 重新检索（最多 3 轮）。返回完整 answer、citations 列表、retrieval 统计和 tool 轨迹。',
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string(),
            }),
          )
          .describe('对话历史（最后一条必须是 user）'),
        context_doc_id: z.string().optional().describe('当前查看文档 ID（hint 提升该 doc 的优先级）'),
        notebook_id: z.string().optional().describe('限定到某个 notebook'),
        since: z.string().optional().describe('ISO 时间字符串，只返回 blocks.updated_at >= since 的块'),
        until: z.string().optional().describe('ISO 时间字符串，只返回 blocks.updated_at <= until 的块'),
        top_k: z.number().int().min(1).max(20).optional().default(5).describe('返回引用数量（上限；少于此数说明相关结果不足）'),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('引用相关性最低分：低于此分的引用被过滤（数量计入 retrieval.discarded_low_score）。注意 scale：未配 reranker 时 score 是 RRF 分（~0.016-0.033），配了是 0.5-1 归一分'),
        temperature: z.number().min(0).max(2).optional().default(0.3),
        max_tokens: z.number().int().min(16).max(8000).optional().default(2000),
      },
    },
    async ({ messages, context_doc_id, notebook_id, since, until, top_k, min_score, temperature, max_tokens }) => {
      // 语义校验（zod 只管形状）：空 messages / 最后一条非 user → invalid_params
      if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
        return toolError('invalid_params', 'messages 不能为空，且最后一条必须是 role=user', { path: 'messages' })
      }
      if (since && !isValidIsoDate(since)) {
        return toolError('invalid_params', `since 不是合法的 ISO 时间：${since}`, { path: 'since', value: since })
      }
      if (until && !isValidIsoDate(until)) {
        return toolError('invalid_params', `until 不是合法的 ISO 时间：${until}`, { path: 'until', value: until })
      }
      // context_doc_id 不存在时显式报错，而不是静默降级（调用方应知道 id 已失效）
      if (context_doc_id) {
        const denied = denyAiExcludedDoc(context_doc_id)
        if (denied) return denied
        if (getDocById(db, context_doc_id) == null) {
          return toolError('not_found', `context_doc_id 指向的文档不存在：${context_doc_id}`, { context_doc_id })
        }
      }
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const chatMessages: ChatMessage[] = messages as ChatMessage[]
        const result = await runChatSync({
          messages: chatMessages,
          contextDocId: context_doc_id,
          notebookId: notebook_id,
          since,
          until,
          topK: top_k,
          minScore: min_score,
          temperature,
          maxTokens: max_tokens,
        })
        return {
          content: [toText({
            answer: result.answer,
            citations: result.citations.map((c) => ({
              block_id: c.block_id,
              doc_id: c.doc_id,
              doc_title: c.doc_title,
              snippet: c.snippet,
              score: c.score,
            })),
            retrieval: result.retrieval,
            tool_trace: result.toolTrace,
          })],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const notConfigured = msg.startsWith('[未配置]')
        return toolError(notConfigured ? 'not_configured' : 'llm_error', msg, notConfigured ? { fix_hint: NOT_CONFIGURED_HINT } : undefined)
      }
    },
  )

  // ───────────────────── notefast_get_config ─────────────────────
  registerTool(
    'notefast_get_config',
    {
      description:
        '获取服务端当前 AI / 鉴权配置概况（脱敏）。包含 chat、embedding、reranker 的模型名和 provider 标签，以及是否启用读写分离 token、密码鉴权等。不包含 API Key。',
      inputSchema: {},
    },
    async () => {
      const s = getRuntime().status()
      const cfg = s.config
      const mode = {
        passwordRequired: (process.env.AUTH_PASSWORD || '').trim().length > 0,
        readToken: (process.env.READ_TOKEN || '').trim().length > 0,
        writeToken: (process.env.WRITE_TOKEN || '').trim().length > 0,
        apiToken: (process.env.API_TOKEN || '').trim().length > 0,
      }
      return {
        content: [toText({
          enabled: s.enabled,
          chat: cfg.chat ? { model: cfg.chat.chatModel, label: cfg.chat.label, baseUrl: cfg.chat.baseUrl } : null,
          embedding: cfg.embedding ? { model: cfg.embedding.embeddingModel, label: cfg.embedding.label, baseUrl: cfg.embedding.baseUrl } : null,
          reranker: cfg.reranker?.enabled ? { model: cfg.reranker.model, baseUrl: cfg.reranker.baseUrl } : null,
          autoIndex: cfg.autoIndex,
          autoLink: cfg.autoLink
            ? {
                enabled: cfg.autoLink.enabled,
                autoApply: cfg.autoLink.autoApply,
                notebookScope: cfg.autoLink.notebookScope,
                maxPerBlock: cfg.autoLink.maxPerBlock,
                minConfidence: cfg.autoLink.minConfidence,
                minMargin: cfg.autoLink.minMargin,
                excludeAnchorKinds: cfg.autoLink.excludeAnchorKinds,
                excludeSelfDoc: cfg.autoLink.excludeSelfDoc,
                rateLimitPerMinute: cfg.autoLink.rateLimitPerMinute,
              }
            : null,
          auth: mode,
        })],
      }
    },
  )
}
