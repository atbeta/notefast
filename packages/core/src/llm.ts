/**
 * LLM Provider 接口
 *
 * 轻量聊天补全抽象。用于标题生成、摘要、改写等轻量 AI 功能。
 * 不承载长对话或复杂 Agent 逻辑。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface LLMProvider {
  readonly name: string

  /** 发起一次聊天补全 */
  chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<string>
}

export type LLMProviderFactory = (config: Record<string, string>) => LLMProvider
