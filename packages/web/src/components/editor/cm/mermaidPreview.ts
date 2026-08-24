import { StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import i18next from '../../../i18n'
import { nextMermaidId, renderMermaidSvg } from '../../../lib/mermaid'

/**
 * Mermaid 内联预览：```mermaid 围栏块在光标不在块内时渲染为 SVG 图；
 * 光标进入块内回退源码。与 mathPreview / tablePreview 同一模式，文档仍是 Markdown。
 * mermaid 经 lib/mermaid 懒加载（首个图表才拉库），本模块只静态引入异步入口，
 * 编辑器静态依赖链不含 mermaid。
 *
 * 与 math 的差异：mermaid SVG 按 data-theme 着色，widget 需监听主题切换重渲染
 * （KaTeX 继承文字色，无此需求）。
 */

// mermaid 开围栏：```mermaid（无别名；alias 由阅读态 BlockRenderer 也仅认 mermaid）
const MERMAID_FENCE_OPEN_RE = /^\s*```mermaid\s*$/
const ANY_FENCE_RE = /^\s*```/

function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

class MermaidWidget extends WidgetType {
  private cancelRender: (() => void) | null = null
  private themeObserver: MutationObserver | null = null

  constructor(
    readonly src: string,
    readonly lineFrom: number,
  ) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.src === this.src && other.lineFrom === this.lineFrom
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-mermaid-preview'
    const status = document.createElement('div')
    status.className = 'cm-mermaid-preview-status'
    status.textContent = i18next.t('mermaid.loading')
    wrap.appendChild(status)

    // 异步渲染 + cancelled 标志防竞态（widget 销毁 / 主题切换重渲染后旧回调不再写 DOM）
    let cancelled = false
    this.cancelRender = () => {
      cancelled = true
    }

    const render = () => {
      if (cancelled) return
      renderMermaidSvg(this.src, currentTheme(), nextMermaidId())
        .then((svg) => {
          if (cancelled) return
          // securityLevel: strict（见 lib/mermaid.ts），同阅读态 MermaidDiagram 的注入姿势
          wrap.innerHTML = svg
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // 渲染失败：错误行 + 源码回退（点击仍可进块编辑），对齐阅读态失败形态
          wrap.textContent = ''
          const errLine = document.createElement('div')
          errLine.className = 'cm-mermaid-preview-error'
          const msg = err instanceof Error ? err.message : String(err)
          errLine.textContent = i18next.t('mermaid.renderFailedWith', { error: msg })
          const pre = document.createElement('pre')
          pre.className = 'cm-mermaid-preview-source'
          pre.textContent = this.src
          wrap.append(errLine, pre)
        })
    }
    render()

    // 主题切换重渲染（math 无此需求：KaTeX 继承文字色；mermaid SVG 按主题着色）
    this.themeObserver = new MutationObserver(() => {
      wrap.textContent = ''
      const s = document.createElement('div')
      s.className = 'cm-mermaid-preview-status'
      s.textContent = i18next.t('mermaid.loading')
      wrap.appendChild(s)
      render()
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    // 点击图片把光标移入源码块，回退源码编辑（stopPropagation 防 CM 指针选区把光标映射到块外）
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
    this.themeObserver?.disconnect()
  }

  ignoreEvent(): boolean {
    return false
  }
}

export interface MermaidBlockRange {
  from: number
  to: number
  src: string
}

/** 扫描文档找出所有 mermaid 围栏块。与 mathPreview 同款的朴素围栏扫描，
 *  接受同款局限：不识别 ~~~ 围栏、围栏内的 ``` 行会提前闭合。 */
export function findMermaidBlocks(state: EditorState): MermaidBlockRange[] {
  const blocks: MermaidBlockRange[] = []
  let inFence = false
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (!ANY_FENCE_RE.test(line.text)) continue
    if (!inFence && MERMAID_FENCE_OPEN_RE.test(line.text)) {
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
        // 空图块不装饰（留源码态便于直接编辑）
        if (src) blocks.push({ from: line.from, to: closeTo, src })
        i = j // for 循环 i++ 后从闭围栏下一行继续
        continue
      }
      // 未闭合的 mermaid 开围栏按普通围栏处理（落入下方 inFence 翻转）
    }
    inFence = !inFence
  }
  return blocks
}

function buildDecorations(state: EditorState, blocks: MermaidBlockRange[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const sel = state.selection.main
  for (const block of blocks) {
    // 光标 / 选区落在图块内时显示源码，便于编辑
    if (sel.from <= block.to && sel.to >= block.from) continue
    ranges.push(
      Decoration.replace({
        widget: new MermaidWidget(block.src, block.from),
        block: true,
      }).range(block.from, block.to),
    )
  }
  return Decoration.set(ranges, true)
}

export interface MermaidPreviewValue {
  blocks: MermaidBlockRange[]
  deco: DecorationSet
}

/** block 级 Decoration 必须由 StateField 提供（ViewPlugin 只支持行内装饰）。
 *  导出 StateField 本体（既是 Extension），便于测试经 state.field() 直读装饰集。
 *  选区变化只按缓存块范围重建装饰，避免每移光标全文扫一遍。 */
export const mermaidPreview = StateField.define<MermaidPreviewValue>({
  create(state) {
    const blocks = findMermaidBlocks(state)
    return { blocks, deco: buildDecorations(state, blocks) }
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const blocks = tr.docChanged ? findMermaidBlocks(tr.state) : value.blocks
    return { blocks, deco: buildDecorations(tr.state, blocks) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})
