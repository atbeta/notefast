/**
 * 编辑器 Mermaid 灯箱 — 预览 widget 展开按钮触发
 *
 * 监听 VIEW_MERMAID_EVENT，把已渲染的 SVG 注入 ImageLightbox 放大查看
 * （与阅读态 MermaidDiagram 的灯箱姿势一致：children 注入 SVG + measureKey 重测尺寸）。
 */

import { useEffect, useState } from 'react'
import { VIEW_MERMAID_EVENT, type ViewMermaidDetail } from '../../lib/editMermaid'
import ImageLightbox from '../ImageLightbox'

export default function MermaidViewer() {
  const [session, setSession] = useState<ViewMermaidDetail | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<ViewMermaidDetail>).detail
      if (d?.svg) setSession(d)
    }
    window.addEventListener(VIEW_MERMAID_EVENT, handler)
    return () => window.removeEventListener(VIEW_MERMAID_EVENT, handler)
  }, [])

  if (!session) return null

  return (
    <ImageLightbox
      alt={session.label}
      measureKey={session.svg}
      onClose={() => setSession(null)}
    >
      <div dangerouslySetInnerHTML={{ __html: session.svg }} />
    </ImageLightbox>
  )
}