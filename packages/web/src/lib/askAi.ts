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
  /** 阅读态块 ID；有则预填，供 update_block 对准眼前这段 */
  blockId?: string
}

export function dispatchAskAi(detail: AskAiDetail): void {
  window.dispatchEvent(new CustomEvent<AskAiDetail>(ASK_AI_EVENT, { detail }))
}

/** 预填草稿：前缀必须在首行（用量统计依赖）；blockId 行可选。 */
export function formatAskAiDraft(prefix: string, quote: string, blockIdLine?: string): string {
  const quoted = quote.split('\n').map((l) => `> ${l}`).join('\n')
  const id = blockIdLine ? `${blockIdLine}\n` : ''
  return `${prefix}\n${id}${quoted}\n\n`
}
