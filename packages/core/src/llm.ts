/**
 * LLM Provider 接口
 *
 * runtime.ts 提供 OpenAI 兼容的具体实现。
 * 此文件只保留接口契约，便于未来替换为其他实现（如 transformers.js 本地推理）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 对应被调用的 tool_call.id（role=tool 时必填） */
  tool_call_id?: string
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

/** OpenAI 兼容的 function/tool 定义 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/** LLM 在响应中请求的 tool call */
export interface ToolCall {
  /** OpenAI 返回的 id（用于回传 tool result） */
  id: string
  /** 调用名（对应 ToolDefinition.function.name） */
  name: string
  /** 解析后的参数对象 */
  args: Record<string, unknown>
}

export interface ChatWithToolsOptions extends ChatCompletionOptions {
  /** 暴露给 LLM 的工具列表 */
  tools?: ToolDefinition[]
}

export interface ChatWithToolsResult {
  /** 最终文本（可能为空，仅含 tool_calls） */
  content: string
  /** LLM 请求的工具调用；空数组表示 LLM 已给出最终答案 */
  tool_calls: ToolCall[]
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<string>
  /**
   * 可选：支持 tool call 的版本。若未实现，调用方走 fallback（不支持 agent loop）。
   */
  chatWithTools?(messages: ChatMessage[], options?: ChatWithToolsOptions): Promise<ChatWithToolsResult>
}

export type LLMProviderFactory = (config: Record<string, string>) => LLMProvider