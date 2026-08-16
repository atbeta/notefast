/**
 * @notefast/shared — NoteFast 与 NoteFastEditor 共享的可复用渲染/编辑器组件。
 *
 * 纯前端、零 KB/后端依赖：Markdown 渲染（react-markdown + GFM + Mermaid + KaTeX）
 * 与 CodeMirror 6 混合渲染编辑器。i18n 复用宿主 i18next 实例（不自带实例），
 * 组件内 useTranslation() / getI18n() 直接落到宿主语言包。
 */

// Markdown 渲染组件
export {
  ChatMarkdown,
  MermaidDiagram,
  MathBlock,
  MathInline,
} from './render'

// CodeMirror 编辑器
export {
  default as CodeMirrorEditor,
  SelectionReporter,
  SELECTION_DEBOUNCE_MS,
  editorTheme,
  editorHighlight,
  RefineSession,
} from './editor'
export type {
  CodeMirrorEditorHandle,
  SelectionRect,
  SelectionAnchor,
} from './editor'

// lib 辅助（懒加载的 Mermaid / KaTeX / highlight.js，及公式分派判定）
export { nextMermaidId, renderMermaidSvg } from './lib/mermaid'
export { renderMathToHtml, INLINE_MATH_SRC } from './lib/katex'
export { highlightCode } from './lib/highlight'
export { classifyChatMath } from './lib/chatMath'
export type { ChatMathKind } from './lib/chatMath'

// ui 原语（shared 组件自用 + 宿主可复用）
export { Tooltip, CopyButton } from './ui'

// 共享类型
export type {
  PreviewItem,
  EditorSettings,
  ImportPayload,
} from './types'
