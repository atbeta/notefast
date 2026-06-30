/**
 * LLM Provider 接口
 *
 * runtime.ts 提供 OpenAI 兼容的具体实现。
 * 此文件只保留接口契约，便于未来替换为其他实现（如 transformers.js 本地推理）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** OpenAI response_format 兼容选项 */
export interface ResponseFormat {
  type: 'json_object' | 'text'
}

export interface ChatCompletionOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  /** 让模型强制返回 JSON（仅 OpenAI 兼容服务支持） */
  responseFormat?: ResponseFormat
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<string>
}

export type LLMProviderFactory = (config: Record<string, string>) => LLMProvider