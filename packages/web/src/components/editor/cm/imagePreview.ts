import { StateField } from '@codemirror/state'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

// 整行只有一个图片语法时命中：![alt](src) 或 ![alt](src "title")
export const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/

/** asset:<sha256> 是 AssetStore 稳定引用，渲染时解析为 API 路径（与 BlockRenderer 一致） */
function resolveSrc(raw: string): string {
  return raw.startsWith('asset:') ? `/api/v1/assets/${raw.slice(6)}` : raw
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly lineFrom: number,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.lineFrom === this.lineFrom
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-image-preview'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    wrap.appendChild(img)
    if (this.alt) {
      const caption = document.createElement('div')
      caption.className = 'cm-image-caption'
      caption.textContent = this.alt
      wrap.appendChild(caption)
    }
    // 点击图片把光标移到该行，便于回到源码编辑（stopPropagation 防 CM 指针选区把光标映射回块外）
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ selection: { anchor: this.lineFrom } })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

interface ImageLine {
  from: number
  to: number
  src: string
  alt: string
}

function findImageLines(state: EditorState): ImageLine[] {
  const lines: ImageLine[] = []
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    const m = IMAGE_LINE_RE.exec(line.text)
    if (!m) continue
    const src = resolveSrc(m[2])
    if (src.startsWith('data:')) continue
    lines.push({ from: line.from, to: line.to, src, alt: m[1] })
  }
  return lines
}

function buildDecorations(state: EditorState, images: ImageLine[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const sel = state.selection.main
  for (const img of images) {
    if (sel.from <= img.to && sel.to >= img.from) continue
    ranges.push(
      Decoration.replace({
        widget: new ImageWidget(img.src, img.alt, img.from),
        block: true,
      }).range(img.from, img.to),
    )
  }
  return Decoration.set(ranges)
}

interface ImagePreviewValue {
  images: ImageLine[]
  deco: DecorationSet
}

/**
 * 图片行内预览：非光标行的图片语法渲染为 <img>，本质是装饰层，文档仍是 Markdown 源码。
 * 注意：block 级 Decoration 必须由 StateField 提供（ViewPlugin 只支持行内装饰）。
 * 选区变化只按缓存图片行重建装饰，避免每移光标全文扫一遍。
 */
export const imagePreview: Extension = StateField.define<ImagePreviewValue>({
  create(state) {
    const images = findImageLines(state)
    return { images, deco: buildDecorations(state, images) }
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const images = tr.docChanged ? findImageLines(tr.state) : value.images
    return { images, deco: buildDecorations(tr.state, images) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})
