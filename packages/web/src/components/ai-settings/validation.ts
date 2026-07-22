import type { ProviderDefinition, RerankerDefinition } from '@notefast/core'
import { ApiError } from '../../hooks/useAPI'

/** Field-level error map: 每个 ProviderDefinition 字段都可有错误 */
export type FieldErrors = Partial<Record<keyof ProviderDefinition | 'global', string>>
export type RerankerFieldErrors = Partial<Record<keyof RerankerDefinition | 'global', string>>

export interface FormErrors {
  chat?: FieldErrors
  embedding?: FieldErrors
  reranker?: RerankerFieldErrors
}

/**
 * 把 validateConfig 返回的字符串错误按前缀切分到具体字段
 *  "Chat provider 必须填写 chatModel" → chat.chatModel
 *  "Chat provider baseUrl 不能为空" → chat.baseUrl
 *  "Embedding provider 必须填写 embeddingModel" → embedding.embeddingModel
 *  "Embedding provider baseUrl 不能为空" → embedding.baseUrl
 *  "Reranker baseUrl 不能为空" → reranker.baseUrl
 *  "Reranker model 不能为空" → reranker.model
 *  "AutoLink ..." → global（不属于上面三类）
 */
export function errorsToFields(errors: string[]): FormErrors {
  const out: FormErrors = {}
  const fallback: string[] = []
  for (const e of errors) {
    if (e.startsWith('Chat provider 必须填写 chatModel') || e.includes('Chat provider chatModel')) {
      ;(out.chat ??= {}).chatModel = e
    } else if (e.includes('Chat provider baseUrl') || e === 'Chat provider baseUrl 不能为空') {
      ;(out.chat ??= {}).baseUrl = e
    } else if (e.includes('Chat provider timeout')) {
      ;(out.chat ??= {}).timeoutMs = e
    } else if (e.startsWith('Embedding provider') && e.includes('embeddingModel')) {
      ;(out.embedding ??= {}).embeddingModel = e
    } else if (e.startsWith('Embedding provider') && e.includes('baseUrl')) {
      ;(out.embedding ??= {}).baseUrl = e
    } else if (e.startsWith('Embedding provider') && e.includes('timeout')) {
      ;(out.embedding ??= {}).timeoutMs = e
    } else if (e.startsWith('Reranker') && e.includes('baseUrl')) {
      ;(out.reranker ??= {}).baseUrl = e
    } else if (e.startsWith('Reranker') && e.includes('model')) {
      ;(out.reranker ??= {}).model = e
    } else if (e.startsWith('Reranker') && e.includes('timeout')) {
      ;(out.reranker ??= {}).timeoutMs = e
    } else {
      fallback.push(e)
    }
  }
  if (fallback.length > 0) {
    out.chat ??= {}
    out.chat.global = fallback.join('；')
  }
  return out
}

/** 从 ApiError 提取服务端 errors[]（类型守卫：body 为对象且 errors 是 string 数组） */
export function serverValidationErrors(e: unknown): string[] {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') return []
  const errors = (e.body as { errors?: unknown }).errors
  return Array.isArray(errors) ? errors.filter((x): x is string => typeof x === 'string') : []
}

/** 客户端快速校验（基于本地状态，避免不必要的网络往返） */
export function localValidate(c: {
  chat: ProviderDefinition | null
  embedding: ProviderDefinition | null
  reranker: RerankerDefinition | null
}): string[] {
  const errs: string[] = []
  if (c.chat) {
    if (!c.chat.baseUrl.trim()) errs.push('Chat provider baseUrl 不能为空')
    if (!c.chat.chatModel.trim()) errs.push('Chat provider 必须填写 chatModel')
    if (c.chat.timeoutMs < 1000 || c.chat.timeoutMs > 600_000) {
      errs.push('Chat provider timeoutMs 应在 1000-600000 之间')
    }
  }
  if (c.embedding) {
    if (!c.embedding.baseUrl.trim()) errs.push('Embedding provider baseUrl 不能为空')
    if (!c.embedding.embeddingModel.trim()) {
      errs.push('Embedding provider 必须填写 embeddingModel')
    }
    if (c.embedding.timeoutMs < 1000 || c.embedding.timeoutMs > 600_000) {
      errs.push('Embedding provider timeoutMs 应在 1000-600000 之间')
    }
  }
  return errs
}
