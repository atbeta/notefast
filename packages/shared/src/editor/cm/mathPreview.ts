import { StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import i18next from '../../i18n'
import { renderMathToHtml } from '../../lib/katex'

/**
 * 块级公式内联预览：```math（别名 latex/katex/tex）围栏块在光标不在块内时
 * 渲染为 KaTeX 公式；光标进入块内回退源码。与 tablePreview 同一模式，文档仍是 Markdown。
 * KaTeX 经 lib/katex 懒加载（首个公式才拉库 + CSS），本模块只静态引入异步入口，
 * 编辑器静态依赖链不含 katex。
 */

// math 开围栏：```math / ```latex / ```katex / ```tex
const MATH_FENCE_OPEN_RE = /^\s*```(math|latex|katex|tex)\s*$/
const ANY_FENCE_RE = /^\s*```/

class MathWidget extends WidgetType {
  private cancelRender: (() => void) | null = null

  constructor(
    readonly src: string,
    readonly lineFrom: number,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.src === this.src && other.lineFrom === this.lineFrom
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-math-preview'
    const status = document.createElement('div')
    status.className = 'cm-math-preview-status'
    status.textContent = i18next.t('math.loading')
    wrap.appendChild(status)

    // 异步渲染 + cancelled 标志防竞态（widget 销毁后不再写 DOM），同 MathBlock 模式
    let cancelled = false
    this.cancelRender = () => {
      cancelled = true
    }
    renderMathToHtml(this.src, true)
      .then((html) => {
        if (cancelled) return
        // katex trust:false 输出无用户 HTML，可安全注入（见 lib/katex.ts）
        wrap.innerHTML = html
      })
      .catch(() => {
        if (cancelled) return
        // 渲染失败回退源码文本（点击仍可进块编辑）
        wrap.textContent = ''
        const pre = document.createElement('pre')
        pre.className = 'cm-math-preview-source'
        pre.textContent = this.src
        wrap.appendChild(pre)
      })

    // 点击公式把光标移入源码块，回退源码编辑（stopPropagation 防 CM 指针选区把光标映射到块外）
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ selection: { anchor: this.lineFrom } })
      view.focus()
    })
    return wrap
  }

  destroy(): void {
    this.cancelRender?.()
  }

  ignoreEvent(): boolean {
    return false
  }
}

interface MathBlockRange {
  from: number
  to: number
  src: string
}

/** 扫描文档找出所有 math 围栏块。与 tablePreview 同款的朴素围栏扫描，
 *  接受同款局限：不识别 ~~~ 围栏、围栏内的 ``` 行会提前闭合。 */
export function findMathBlocks(state: EditorState): MathBlockRange[] {
  const blocks: MathBlockRange[] = []
  let inFence = false
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (!ANY_FENCE_RE.test(line.text)) continue
    if (!inFence && MATH_FENCE_OPEN_RE.test(line.text)) {
      // 消费到下一个 ``` 闭围栏
      const srcLines: string[] = []
      let j = i + 1
      let closeTo = -1
      while (j <= state.doc.lines) {
        const l = state.doc.line(j)
        if (ANY_FENCE_RE.test(l.text)) {
          closeTo = l.to
          break
        }
        srcLines.push(l.text)
        j++
      }
      if (closeTo >= 0) {
        const src = srcLines.join('\n').trim()
        // 空公式块不装饰（留源码态便于直接编辑）
        if (src) blocks.push({ from: line.from, to: closeTo, src })
        i = j // for 循环 i++ 后从闭围栏下一行继续
        continue
      }
      // 未闭合的 math 开围栏按普通围栏处理（落入下方 inFence 翻转）
    }
    inFence = !inFence
  }
  return blocks
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const sel = state.selection.main
  for (const block of findMathBlocks(state)) {
    // 光标 / 选区落在公式块内时显示源码，便于编辑
    if (sel.from <= block.to && sel.to >= block.from) continue
    ranges.push(
      Decoration.replace({
        widget: new MathWidget(block.src, block.from),
        block: true,
      }).range(block.from, block.to),
    )
  }
  return Decoration.set(ranges, true)
}

/** block 级 Decoration 必须由 StateField 提供（ViewPlugin 只支持行内装饰）。
 *  导出 StateField 本体（既是 Extension），便于测试经 state.field() 直读装饰集。 */
export const mathPreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})
