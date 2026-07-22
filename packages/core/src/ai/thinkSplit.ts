/**
 * 从模型输出中拆分「思考」与「答案」。
 *
 * 兼容：
 * - 独立字段（由调用方处理）：reasoning_content / reasoning
 * - 正文内嵌标签：<think>...</think>（DeepSeek / 部分开源模型）
 */

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

export function splitThinkContent(text: string): { reasoning: string; content: string } {
  if (!text) return { reasoning: '', content: '' }
  const lower = text.toLowerCase()
  const openIdx = lower.indexOf(THINK_OPEN)
  if (openIdx < 0) return { reasoning: '', content: text }

  const afterOpen = openIdx + THINK_OPEN.length
  const closeIdx = lower.indexOf(THINK_CLOSE, afterOpen)
  if (closeIdx < 0) {
    // 未闭合：整段视为思考（流式中常见）
    return {
      reasoning: text.slice(afterOpen),
      content: text.slice(0, openIdx).trim(),
    }
  }

  const reasoning = text.slice(afterOpen, closeIdx).trim()
  const before = text.slice(0, openIdx)
  const after = text.slice(closeIdx + THINK_CLOSE.length)
  const content = (before + after).replace(/^\s*\n+/, '').trimStart()
  return { reasoning, content }
}

/**
 * 流式拆分器：边收 token 边产出 reasoning / content。
 * 在看到完整开标签前会缓冲，避免把 `<thi` 误当正文。
 */
export class ThinkStreamParser {
  private buf = ''
  private inThink = false
  private started = false

  push(delta: string): { reasoning: string; content: string } {
    if (!delta) return { reasoning: '', content: '' }
    this.buf += delta
    let reasoning = ''
    let content = ''

    while (this.buf.length > 0) {
      if (!this.inThink) {
        const lower = this.buf.toLowerCase()
        const openIdx = lower.indexOf(THINK_OPEN)
        if (openIdx >= 0) {
          if (openIdx > 0) content += this.buf.slice(0, openIdx)
          this.buf = this.buf.slice(openIdx + THINK_OPEN.length)
          this.inThink = true
          this.started = true
          continue
        }
        // 可能是开标签前缀：保留尾部潜在前缀
        const hold = partialSuffixMatch(this.buf, THINK_OPEN)
        if (hold > 0) {
          content += this.buf.slice(0, this.buf.length - hold)
          this.buf = this.buf.slice(this.buf.length - hold)
          break
        }
        content += this.buf
        this.buf = ''
        break
      }

      // inThink
      const lower = this.buf.toLowerCase()
      const closeIdx = lower.indexOf(THINK_CLOSE)
      if (closeIdx >= 0) {
        reasoning += this.buf.slice(0, closeIdx)
        this.buf = this.buf.slice(closeIdx + THINK_CLOSE.length)
        this.inThink = false
        continue
      }
      const hold = partialSuffixMatch(this.buf, THINK_CLOSE)
      if (hold > 0) {
        reasoning += this.buf.slice(0, this.buf.length - hold)
        this.buf = this.buf.slice(this.buf.length - hold)
        break
      }
      reasoning += this.buf
      this.buf = ''
      break
    }

    return { reasoning, content }
  }

  /** 流结束时冲刷缓冲；未闭合的 think 全部归入 reasoning */
  flush(): { reasoning: string; content: string } {
    if (!this.buf) return { reasoning: '', content: '' }
    if (this.inThink || (this.started && this.buf.toLowerCase().startsWith(THINK_OPEN.slice(0, this.buf.length)))) {
      const leftover = this.inThink ? this.buf : this.buf.replace(/^<think>/i, '')
      this.buf = ''
      this.inThink = false
      return { reasoning: leftover, content: '' }
    }
    const content = this.buf
    this.buf = ''
    return { reasoning: '', content }
  }
}

/** buf 后缀与 target 前缀的最长匹配长度 */
function partialSuffixMatch(buf: string, target: string): number {
  const max = Math.min(buf.length, target.length - 1)
  for (let n = max; n >= 1; n--) {
    if (target.toLowerCase().startsWith(buf.slice(-n).toLowerCase())) return n
  }
  return 0
}
