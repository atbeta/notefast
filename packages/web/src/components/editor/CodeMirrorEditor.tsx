import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { editorTheme, editorHighlight } from './cm/theme'
import { imagePreview } from './cm/imagePreview'
import { tablePreview } from './cm/tablePreview'
import { mathPreview } from './cm/mathPreview'
import { ghostTextExtension, ghostTextState, setGhostText, clearGhostText } from './cm/ghostText'
import { MD_LINK_HREF_PLACEHOLDER } from '../../lib/markdownHref'
import { editorKeymap } from './cm/keymap'
import { SelectionReporter } from './cm/selectionReport'
import type { SelectionAnchor } from './cm/selectionReport'
import { buildReplaceRangeUpdate } from './cm/refineReplace'
import TableEditorDialog from './TableEditorDialog'
import { parseTable, serializeTable, tablesEqual, blankTable, tableInsertAffixes, type ParsedTable } from './cm/tableModel'
import { dispatchEditTable, EDIT_TABLE_EVENT, type EditTableDetail } from '../../lib/editTable'

/** 暴露给工具栏 / 上传 hook / 父组件的命令式编辑 API（与旧 textarea 版签名保持一致） */
export interface CodeMirrorEditorHandle {
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
  wrapSelection: (left: string, right?: string) => void
  focus: () => void
  getSelectionText: () => string
  /** 光标前 / 后全文，供 AI 续写 infill */
  getCursorSplit: () => { prefix: string; suffix: string }
  /** 改写流式原地替换：把 [from, to) 渐进替换为 text（选区气泡用） */
  replaceRange: (from: number, to: number, text: string) => void
  /** 插入空 GFM 表并打开网格编辑 */
  insertTable: () => void
}

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onAiContinue: () => void
  onImageFile: (file: File) => void
  ghostText: string
  /** 幽灵字旁的操作提示，如「Tab 接受 · Esc 取消」 */
  ghostHint?: string
  /** 改写：幽灵字盖在该区间上；缺省则插在光标处 */
  ghostRange?: { from: number; to: number }
  onGhostAccept: () => void
  onGhostDismiss: () => void
  /** 非空选区 debounce 上报锚点（含 rect/text/from/to）；清空、失焦、卸载报 null */
  onSelectionChange?: (anchor: SelectionAnchor | null) => void
  /** 光标位置（含空选区），供右栏「相关」跟当前块 */
  onCaret?: (offset: number, markdown: string) => void
  placeholder?: string
  autoFocus?: boolean
}

function clampPos(view: EditorView, pos: number): number {
  return Math.max(0, Math.min(pos, view.state.doc.length))
}

function insertAtCursorCmd(view: EditorView, text: string, opts?: { cursorOffset?: number; selectStart?: number }): void {
  const { from, to } = view.state.selection.main
  const cursorOffset = opts?.cursorOffset ?? text.length
  const anchor = clampPos(view, opts?.selectStart !== undefined ? from + opts.selectStart : from + cursorOffset)
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
}

function wrapSelectionCmd(view: EditorView, left: string, right = left): void {
  const { from, to } = view.state.selection.main
  const middle = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: left + middle + right },
    selection:
      from === to
        ? { anchor: clampPos(view, from + left.length) }
        : { anchor: clampPos(view, from + left.length), head: clampPos(view, to + left.length) },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
}

function insertTableCmd(view: EditorView): void {
  const snippet = serializeTable(blankTable())
  const { from, to } = view.state.selection.main
  const atDocStart = from === 0
  const beforeChar = from > 0 ? view.state.sliceDoc(from - 1, from) : null
  const { prefix, suffix } = tableInsertAffixes(beforeChar, atDocStart)
  const insert = prefix + snippet + suffix
  const tableFrom = from + prefix.length
  const tableTo = tableFrom + snippet.length
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: clampPos(view, tableTo + suffix.length) },
    scrollIntoView: true,
    userEvent: 'input',
  })
  dispatchEditTable({ from: tableFrom, to: tableTo, lines: snippet.split('\n') })
}

/**
 * CodeMirror 6 混合渲染编辑器：底层始终是 Markdown 源码（零转换），
 * 装饰层提供语法高亮 / 标题放大 / 图片预览 / AI ghost text。
 * value 为受控属性，编辑器内部变更经 onChange 流出，外部变更（加载/草稿恢复）整体替换。
 */
const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    // keymap / 事件回调全部经 propsRef 取最新 props，EditorView 只创建一次
    const propsRef = useRef(props)
    propsRef.current = props
    const lastEmittedRef = useRef(props.value)
    // 标记「最近一次 dispatch 是编辑器内部写回（表格等）」：value effect 检测到
    // 时跳过光标跳转，避免表格编辑完成后光标/滚动被重置到别处
    const tableWritebackRef = useRef(false)

    const [tableSession, setTableSession] = useState<{
      from: number
      to: number
      table: ParsedTable
    } | null>(null)
    const tableSessionRef = useRef(tableSession)
    tableSessionRef.current = tableSession

    const applyTable = useCallback((table: ParsedTable, thenSource: boolean) => {
      const view = viewRef.current
      const sess = tableSessionRef.current
      if (!view || !sess) return
      if (!tablesEqual(table, sess.table)) {
        tableWritebackRef.current = true
        view.dispatch({
          changes: { from: sess.from, to: sess.to, insert: serializeTable(table) },
          userEvent: 'input',
        })
      }
      setTableSession(null)
      if (thenSource) {
        requestAnimationFrame(() => {
          const v = viewRef.current
          if (!v) return
          v.dispatch({ selection: { anchor: sess.from } })
          v.focus()
        })
      }
    }, [])

    useEffect(() => {
      const handler = (e: Event) => {
        const d = (e as CustomEvent<EditTableDetail>).detail
        if (!d?.lines?.length) return
        setTableSession({ from: d.from, to: d.to, table: parseTable(d.lines) })
      }
      window.addEventListener(EDIT_TABLE_EVENT, handler)
      return () => window.removeEventListener(EDIT_TABLE_EVENT, handler)
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text, opts) => {
          const view = viewRef.current
          if (view) insertAtCursorCmd(view, text, opts)
        },
        wrapSelection: (left, right) => {
          const view = viewRef.current
          if (view) wrapSelectionCmd(view, left, right)
        },
        focus: () => viewRef.current?.focus(),
        getSelectionText: () => {
          const view = viewRef.current
          if (!view) return ''
          const { from, to } = view.state.selection.main
          return view.state.sliceDoc(from, to)
        },
        getCursorSplit: () => {
          const view = viewRef.current
          if (!view) return { prefix: '', suffix: '' }
          const head = view.state.selection.main.head
          return {
            prefix: view.state.doc.sliceString(0, head),
            suffix: view.state.doc.sliceString(head),
          }
        },
        replaceRange: (from, to, text) => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({
            ...buildReplaceRangeUpdate(view.state.doc.length, from, to, text),
            scrollIntoView: true,
            userEvent: 'input',
          })
        },
        insertTable: () => {
          const view = viewRef.current
          if (view) insertTableCmd(view)
        },
      }),
      [],
    )

    useEffect(() => {
      if (!hostRef.current) return
      // 选区气泡上报：非空选区 debounce 后经 onSelectionChange 报锚点（桌面端 SelectionBubble）
      const selectionReporter = new SelectionReporter((anchor) =>
        propsRef.current.onSelectionChange?.(anchor),
      )
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: propsRef.current.value,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            history(),
            closeBrackets(),
            highlightSelectionMatches(),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            syntaxHighlighting(editorHighlight),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            editorTheme,
            EditorView.lineWrapping,
            cmPlaceholder(propsRef.current.placeholder ?? ''),
            imagePreview,
            tablePreview,
            mathPreview,
            ghostTextExtension,
            editorKeymap({
              hasGhost: () => !!propsRef.current.ghostText,
              acceptGhost: () => propsRef.current.onGhostAccept(),
              dismissGhost: () => propsRef.current.onGhostDismiss(),
              onSave: () => propsRef.current.onSave(),
              onAiContinue: () => propsRef.current.onAiContinue(),
              wrapSelection: (left, right) => {
                const v = viewRef.current
                if (v) wrapSelectionCmd(v, left, right)
              },
              insertLink: () => {
                const v = viewRef.current
                if (!v) return
                const { from, to } = v.state.selection.main
                const sel = v.state.sliceDoc(from, to)
                if (sel.length > 0) {
                  wrapSelectionCmd(v, '[', `](${MD_LINK_HREF_PLACEHOLDER})`)
                } else {
                  const linkText = 'text'
                  insertAtCursorCmd(v, `[${linkText}](${MD_LINK_HREF_PLACEHOLDER})`, {
                    cursorOffset: linkText.length + 3,
                  })
                }
              },
            }),
            EditorView.domEventHandlers({
              paste(event) {
                const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
                  f.type.startsWith('image/'),
                )
                if (!file) return false
                event.preventDefault()
                propsRef.current.onImageFile(file)
                return true
              },
              drop(event) {
                const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
                  f.type.startsWith('image/'),
                )
                if (!file) return false
                event.preventDefault()
                propsRef.current.onImageFile(file)
                return true
              },
              // IME 合成：compositionstart/end 上报至 SelectionReporter，
              // 期间跳过选区上报（CM 本身在合成期内不重渲，但选区坐标 / text 仍会跳变）
              compositionstart() {
                selectionReporter.setComposing(true)
              },
              compositionend() {
                selectionReporter.setComposing(false)
              },
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                const next = update.state.doc.toString()
                lastEmittedRef.current = next
                propsRef.current.onChange(next)
              }
              if (update.selectionSet || update.docChanged) {
                const md = update.state.doc.toString()
                propsRef.current.onCaret?.(update.state.selection.main.head, md)
              }
              // 用户输入（含粘贴/拖拽）取消 AI 续写 ghost
              if (
                update.docChanged
                && propsRef.current.ghostText
                && update.transactions.some(
                  (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'),
                )
              ) {
                propsRef.current.onGhostDismiss()
              }
            }),
            // 选区上报：updateListener 而非 mouseup/keyup（键盘 shift 选区也能覆盖）
            EditorView.updateListener.of((update) => {
              if (!update.selectionSet && !update.docChanged) return
              if (update.state.selection.main.empty) {
                selectionReporter.clear()
                return
              }
              selectionReporter.schedule(() => {
                const v = viewRef.current
                if (!v || !v.hasFocus) return null
                const cur = v.state.selection.main
                if (cur.empty) return null
                const text = v.state.sliceDoc(cur.from, cur.to)
                if (!text.trim()) return null
                // 锚点取选区末端坐标；末端滚出视口（CM 只渲染视口行，coordsAtPos 返回 null）
                // 回退首端。多行选区两端都可见时锚到更高的一端（首行），避免气泡悬在末端几行之下
                const rectTo = v.coordsAtPos(cur.to)
                const rectFrom = v.coordsAtPos(cur.from)
                const rect = rectTo ?? rectFrom
                if (!rect) return null
                const anchored = rectFrom && rectTo && rectFrom.top < rectTo.top ? rectFrom : rect
                return { rect: anchored, text, from: cur.from, to: cur.to }
              })
            }),
            EditorView.domEventHandlers({
              blur() {
                selectionReporter.clear()
              },
            }),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          ],
        }),
      })
      viewRef.current = view
      // 调试句柄：控制台可用 __cmView 检查 syntax tree / state
      ;(window as unknown as { __cmView: EditorView }).__cmView = view
      if (propsRef.current.autoFocus) {
        view.dispatch({ selection: { anchor: view.state.doc.length } })
        view.focus()
      }
      return () => {
        // 卸载时报 null 收起气泡（父组件仍在，仅切预览/关编辑器）
        selectionReporter.clear()
        if ((window as unknown as { __cmView?: EditorView }).__cmView === view) {
          delete (window as unknown as { __cmView?: EditorView }).__cmView
        }
        view.destroy()
        viewRef.current = null
      }
    }, [])

    // 外部 value 变化（文档加载完成 / 草稿恢复）时整体替换文档内容。
    // 表格编辑等「内部 dispatch 写回」不重置光标（tableWritebackRef 标记）：
    // 否则 dispatch 后父组件 value 变化会触发这里全量替换 + 光标跳到文档末尾，
    // 表现为「编辑完表格跳回文档头/不在原位置」。
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      if (props.value === lastEmittedRef.current) return
      const current = view.state.doc.toString()
      if (props.value !== current) {
        const anchor = props.value.replace(/\r\n/g, '\n').length
        lastEmittedRef.current = props.value
        if (tableWritebackRef.current) {
          // 内部表格写回：内容已在 CM 最新，无需全量替换；保持当前光标/滚动
          tableWritebackRef.current = false
          return
        }
        view.dispatch({
          changes: { from: 0, to: current.length, insert: props.value },
          selection: { anchor },
        })
      }
    }, [props.value])

    // ghostText 属性 → StateField 装饰
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const hint = props.ghostHint ?? ''
      const active = view.state.field(ghostTextState)
      if (!props.ghostText) {
        if (active) view.dispatch({ effects: clearGhostText.of(null) })
        return
      }
      if (props.ghostText === active) return
      view.dispatch({
        effects: setGhostText.of({
          text: props.ghostText,
          hint,
          from: props.ghostRange?.from,
          to: props.ghostRange?.to,
        }),
      })
    }, [props.ghostText, props.ghostHint, props.ghostRange])

    return (
      <>
        <div ref={hostRef} className="min-w-0 flex-1" />
        <TableEditorDialog
          open={tableSession !== null}
          table={tableSession?.table ?? null}
          onDone={(table) => applyTable(table, false)}
          onEditSource={(table) => applyTable(table, true)}
        />
      </>
    )
  },
)

export default CodeMirrorEditor
