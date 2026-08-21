import { Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { closeSearchPanel } from '@codemirror/search'

export interface EditorKeymapCallbacks {
  hasGhost: () => boolean
  acceptGhost: () => void
  dismissGhost: () => void
  onSave: () => void
  onAiContinue: () => void
  wrapSelection: (left: string, right?: string) => void
  insertLink: () => void
}

/**
 * Enter：仅处理「空代码围栏展开」（``` 后回车 → 生成空代码块，光标进块内）。
 * 列表 / 引用的续行与空项退出交给 @codemirror/lang-markdown 自带的
 * insertNewlineContinueMarkdown（本 keymap 返回 false 后落过去）。
 */
export function expandEmptyFence(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  if (!sel.empty || sel.head !== line.to) return false
  const beforeCursor = line.text.slice(0, sel.head - line.from)
  if (!/^\s*```$/.test(beforeCursor)) return false
  // 奇数个围栏在前 = 当前 fence 是关闭符，不做展开
  let fences = 0
  for (let i = 1; i < line.number; i++) {
    if (/^\s*```/.test(state.doc.line(i).text)) fences++
  }
  if (fences % 2 !== 0) return false
  const indent = beforeCursor.match(/^\s*/)?.[0] ?? ''
  view.dispatch({
    changes: { from: sel.head, insert: `\n${indent}\n${indent}\`\`\`` },
    selection: { anchor: sel.head + 1 + indent.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/** 编辑器快捷键（高优先级，先于 lang-markdown / default keymap 执行） */
export function editorKeymap(cb: EditorKeymapCallbacks): Extension {
  return Prec.high(
    keymap.of([
      {
        key: 'Tab',
        run: () => {
          if (!cb.hasGhost()) return false
          cb.acceptGhost()
          return true
        },
      },
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          cb.onSave()
          return true
        },
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          cb.onAiContinue()
          return true
        },
      },
      {
        key: 'Mod-Shift-k',
        preventDefault: true,
        run: () => {
          cb.insertLink()
          return true
        },
      },
      {
        key: 'Mod-b',
        preventDefault: true,
        run: () => {
          cb.wrapSelection('**')
          return true
        },
      },
      {
        key: 'Mod-i',
        preventDefault: true,
        run: () => {
          cb.wrapSelection('*')
          return true
        },
      },
      {
        key: 'Mod-e',
        preventDefault: true,
        run: () => {
          cb.wrapSelection('`')
          return true
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (cb.hasGhost()) {
            cb.dismissGhost()
            return true
          }
          // 搜索面板打开时 Esc 先关面板。不要退出编辑：正文不是对话框，Esc 只收层。
          if (closeSearchPanel(view)) return true
          return false
        },
      },
      { key: 'Enter', run: expandEmptyFence },
    ]),
  )
}
