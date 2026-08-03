/**
 * 「问 AI 关于这一段」跨组件通道
 *
 * BlockSurface（阅读态块菜单）dispatch → Layout 打开聊天面板 + AIChatPanel 预填草稿。
 * 预填带固定前缀（chat.askAboutPrefix），后续统计该前缀在 chat 请求中的占比，
 * 即可零埋点验证块级 AI 入口的真实使用量（v1 的核心验证目标）。
 */

export const ASK_AI_EVENT = 'notefast:ask-ai'

export interface AskAiDetail {
  /** 块 Markdown 引用（发送端已截断） */
  quote: string
}

export function dispatchAskAi(detail: AskAiDetail): void {
  window.dispatchEvent(new CustomEvent<AskAiDetail>(ASK_AI_EVENT, { detail }))
}
