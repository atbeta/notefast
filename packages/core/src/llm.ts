/**
 * LLM Provider 接口
 *
 * runtime.ts 提供 OpenAI 兼容的具体实现。
 * 此文件只保留接口契约，便于未来替换为其他实现（如 transformers.js 本地推理）。
 */

/**
 * OpenAI 多模态消息内容段（与 chat/completions 线格式一致，可原样透传）。
 * 图片用 data URL（base64）承载——外部 LLM 无法访问自托管实例的 asset URL。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[]
  /** 对应被调用的 tool_call.id（role=tool 时必填） */
  tool_call_id?: string
  /**
   * assistant 消息携带的 tool_calls（agent loop 续传时必填）。
   * 严格 OpenAI 协议要求每个 role=tool 消息的 tool_call_id
   * 必须在它前面的 assistant 消息的 tool_calls 里出现过，
   * 否则 provider 会报 "tool result's tool id ... not found"。
   */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** 提取消息纯文本：多模态消息拼接全部 text 段（检索 query / 历史压缩等场景用） */
export function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
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
  /** 可选：模型思考链（DeepSeek reasoning_content 等） */
  reasoning?: string
}

/** 流式 chat / chatWithTools 的增量块 */
export interface StreamChatChunk {
  content?: string
  reasoning?: string
  done?: boolean
  /** streamChatWithTools 结束时带回累计的 tool_calls */
  tool_calls?: ToolCall[]
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<string>
  /**
   * 可选：支持 tool call 的版本。若未实现，调用方走 fallback（不支持 agent loop）。
   */
  chatWithTools?(messages: ChatMessage[], options?: ChatWithToolsOptions): Promise<ChatWithToolsResult>
}