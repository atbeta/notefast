/**
 * 灯箱媒体适配缩放：按视口比例算出「铺满」倍率（允许放大，不只缩小）。
 * Mermaid SVG 的 width/height 常远小于阅读区展示尺寸；若 cap 在 1×，灯箱会显得过小。
 */
export const MEDIA_ZOOM_MIN = 0.25
export const MEDIA_ZOOM_MAX = 8
export const MEDIA_VIEWPORT_FILL = 0.88
export const MEDIA_ZOOM_STEP = 0.25

export function clampUserZoom(z: number): number {
  return Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, z))
}

/** 把自然尺寸适配进视口 fill 比例；小图会放大，大图会缩小。 */
export function fitScale(
  natW: number,
  natH: number,
  viewW: number,
  viewH: number,
  fill = MEDIA_VIEWPORT_FILL,
): number {
  if (natW <= 0 || natH <= 0 || viewW <= 0 || viewH <= 0) return 1
  const s = Math.min((viewW * fill) / natW, (viewH * fill) / natH)
  return Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, s))
}

/**
 * 读 img / svg 的「设计尺寸」。
 * SVG 优先 viewBox，再非百分比 width/height，最后才用 layout 矩形（100% 宽会被容器撑满，不能当自然尺寸）。
 */
export function readMediaNaturalSize(root: Element): { w: number; h: number } | null {
  const img = root instanceof HTMLImageElement ? root : root.querySelector('img')
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { w: img.naturalWidth, h: img.naturalHeight }
  }
  const svg = root instanceof SVGSVGElement ? root : root.querySelector('svg')
  if (!svg) return null
  const vb = svg.viewBox.baseVal
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height }
  const wAttr = svg.getAttribute('width')
  const hAttr = svg.getAttribute('height')
  const w = wAttr && !wAttr.includes('%') ? parseFloat(wAttr) : NaN
  const h = hAttr && !hAttr.includes('%') ? parseFloat(hAttr) : NaN
  if (w > 0 && h > 0) return { w, h }
  const r = svg.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height }
  return null
}

/**
 * Mermaid 会在 SVG 上写 inline `max-width`（等于 viewBox 宽），用来避免正文里撑破版心。
 * 灯箱按 viewBox 放大外框时，这条规则会把图形钉死在左侧，多出来的全是空白。
 * 内联 style 盖过普通 Tailwind 类，必须用 !important 或直接改 style。
 */
export function applySvgZoomFill(style: CSSStyleDeclaration): void {
  style.setProperty('max-width', 'none', 'important')
  style.setProperty('max-height', 'none', 'important')
  style.setProperty('width', '100%', 'important')
  style.setProperty('height', '100%', 'important')
}

export function unlockSvgMaxSize(root: Element): void {
  const svg = root instanceof SVGSVGElement ? root : root.querySelector('svg')
  if (!svg) return
  applySvgZoomFill(svg.style)
}
