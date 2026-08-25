import { StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import i18next from '../../../i18n'
import { renderMathToHtml } from '../../../lib/katex'
import { fencedCodeSpansIn } from './fencedCode'

const MATH_FENCE_LANGS = new Set(['math', 'latex', 'katex', 'tex'])

/**
 * 块级公式内联预览：```math / ~~~math（别名 latex/katex/tex）围栏在光标不在块内时
 * 渲染为 KaTeX；光标进入块内回退源码。围栏范围与 core mapper 共用 mdast 识别。
 * KaTeX 经 lib/katex 懒加载（首个公式才拉库 + CSS），本模块只静态引入异步入口，
 * 编辑器静态依赖链不含 katex。
 */

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

/** 扫描已闭合的 math 围栏。未闭合不装饰，避免输入中途把后文吃进预览。 */
export function findMathBlocks(state: EditorState): MathBlockRange[] {
  const blocks: MathBlockRange[] = []
  for (const span of fencedCodeSpansIn(state.doc)) {
    if (!span.closed) continue
    if (!MATH_FENCE_LANGS.has(span.language.toLowerCase())) continue
    const src = span.value.trim()
    if (!src) continue
    blocks.push({ from: span.from, to: span.to, src })
  }
  return blocks
}

function buildDecorations(state: EditorState, blocks: MathBlockRange[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const sel = state.selection.main
  for (const block of blocks) {
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

export interface MathPreviewValue {
  blocks: MathBlockRange[]
  deco: DecorationSet
}

/** block 级 Decoration 必须由 StateField 提供（ViewPlugin 只支持行内装饰）。
 *  导出 StateField 本体（既是 Extension），便于测试经 state.field() 直读装饰集。
 *  选区变化只按缓存块范围重建装饰，避免每移光标全文扫一遍。 */
export const mathPreview = StateField.define<MathPreviewValue>({
  create(state) {
    const blocks = findMathBlocks(state)
    return { blocks, deco: buildDecorations(state, blocks) }
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const blocks = tr.docChanged ? findMathBlocks(tr.state) : value.blocks
    return { blocks, deco: buildDecorations(tr.state, blocks) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})
