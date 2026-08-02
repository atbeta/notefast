/**
 * AI 语言解析：跟随客户端 UI 语言（web 端经 Accept-Language 头传递）。
 *
 * 只区分 zh / en 两档（与 web 语言包一致）；未传或无法识别回退中文。
 * 用于服务端 AI prompt 模板（chat 系统提示、工具描述、skills、标题生成）。
 */

export type AiLang = 'zh' | 'en'

/** 解析 Accept-Language（如 "en-US,en;q=0.9,zh-CN;q=0.8"）：取第一个语言标签，en 前缀 → en，否则 zh */
export function resolveAiLang(header?: string | null): AiLang {
  const raw = (header ?? '').trim()
  if (!raw) return 'zh'
  const first = raw.split(',')[0]?.trim().split(';')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('en') ? 'en' : 'zh'
}
