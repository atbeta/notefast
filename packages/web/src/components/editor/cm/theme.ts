import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * 编辑器主题：排版体系与阅读态（BlockRenderer / .reading-prose）一致——
 * 正文 16px var(--font-sans)、行高 1.75，标题 28/24/20px（= 1.75/1.5/1.25em），
 * 等宽字体（var(--font-mono)）只用于行内代码与代码块。
 * 颜色全部引用全局 CSS 变量，亮暗主题跟随 data-theme 自动切换。
 * （对齐 Obsidian 的做法：编辑态复用阅读排版，mono 仅留给代码）
 */
export const editorTheme = EditorView.theme({
  '&': {
    color: 'rgb(var(--foreground))',
    backgroundColor: 'transparent',
    fontSize: '16px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.75',
    // 高度随内容增长，滚动交给页面（对齐旧 textarea auto-height 行为）
    overflow: 'visible',
  },
  '.cm-content': {
    padding: '7px 0 64px',
    caretColor: 'rgb(var(--foreground))',
    letterSpacing: '0.005em',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 2px 0 0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'rgb(var(--muted-foreground) / 0.35)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    paddingRight: '12px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '16px',
    padding: '0',
    textAlign: 'right',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'rgb(var(--muted-foreground))',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgb(var(--muted-foreground) / 0.05)',
  },
  '.cm-placeholder': {
    color: 'rgb(var(--muted-foreground) / 0.4)',
    // 与光标视觉对齐：placeholder 是 inline-block widget，若沿用正文 line-height
    // 1.75 会被撑到 28px 高、文字沉到盒内中下，视觉上比 20px 高的光标低 4px
    //（光标在上 placeholder 在下，肉眼可辨）。text-top + 1.25 = 20px 与光标同高同顶。
    verticalAlign: 'text-top',
    lineHeight: '1.25',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgb(var(--primary) / 0.12)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgb(var(--primary) / 0.18)',
    outline: '1px solid rgb(var(--primary) / 0.3)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'rgb(var(--primary) / 0.35)',
  },
  '.cm-panels': {
    backgroundColor: 'rgb(var(--card))',
    color: 'rgb(var(--foreground))',
    borderBottom: '1px solid rgb(var(--border))',
    fontSize: '12px',
  },
  '.cm-panel.cm-search': {
    padding: '6px 8px',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
  },
  '.cm-panel.cm-search input': {
    fontSize: '12px',
    backgroundColor: 'rgb(var(--background))',
    color: 'rgb(var(--foreground))',
    border: '1px solid rgb(var(--border))',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-panel.cm-search button': {
    fontSize: '12px',
    backgroundColor: 'rgb(var(--accent))',
    color: 'rgb(var(--foreground))',
    border: '1px solid rgb(var(--border))',
    borderRadius: '4px',
    padding: '2px 6px',
    cursor: 'pointer',
  },
  '.cm-tooltip': {
    backgroundColor: 'rgb(var(--card))',
    color: 'rgb(var(--foreground))',
    border: '1px solid rgb(var(--border))',
  },
})

/**
 * 混合渲染（Typora-lite）：语法标记符（# * ` > 等）压暗 + 标题按阅读比例放大，
 * 仍是纯源码编辑，零转换。标题字号 = 阅读态 BlockRenderer 的 28/24/20px。
 */
export const editorHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '400' },
  { tag: t.heading1, fontSize: '28px', fontWeight: '700', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.heading2, fontSize: '24px', fontWeight: '600', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.heading3, fontSize: '20px', fontWeight: '600', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.heading4, fontSize: '16px', fontWeight: '600', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.heading5, fontSize: '14px', fontWeight: '600', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.heading6, fontSize: '13px', fontWeight: '600', lineHeight: '1.3', letterSpacing: '-0.01em' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'rgb(var(--muted-foreground))' },
  { tag: t.quote, color: 'rgb(var(--muted-foreground))' },
  { tag: t.link, color: 'rgb(var(--primary))', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: t.url, color: 'rgb(var(--muted-foreground) / 0.65)', wordBreak: 'break-all' },
  {
    tag: t.monospace,
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    backgroundColor: 'rgb(var(--muted-foreground) / 0.08)',
    borderRadius: '3px',
  },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'rgb(var(--muted-foreground) / 0.45)' },
  { tag: t.labelName, color: 'rgb(var(--muted-foreground) / 0.6)' },
])
