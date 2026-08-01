import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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
import { ghostTextExtension, ghostTextState, setGhostText, clearGhostText } from './cm/ghostText'
import { editorKeymap } from './cm/keymap'

/** 暴露给工具栏 / 上传 hook / 父组件的命令式编辑 API（与旧 textarea 版签名保持一致） */
export interface CodeMirrorEditorHandle {
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
  wrapSelection: (left: string, right?: string) => void
  focus: () => void
  getSelectionText: () => string
}

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onToggleMode: () => void
  onAiContinue: () => void
  onCancel: () => void
  onImageFile: (file: File) => void
  ghostText: string
  onGhostAccept: () => void
  onGhostDismiss: () => void
  placeholder?: string
  autoFocus?: boolean
}

function insertAtCursorCmd(view: EditorView, text: string, opts?: { cursorOffset?: number; selectStart?: number }): void {
  const { from, to } = view.state.selection.main
  const cursorOffset = opts?.cursorOffset ?? text.length
  const anchor = opts?.selectStart !== undefined ? from + opts.selectStart : from + cursorOffset
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
        ? { anchor: from + left.length }
        : { anchor: from + left.length, head: to + left.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
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
      }),
      [],
    )

    useEffect(() => {
      if (!hostRef.current) return
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
            ghostTextExtension,
            editorKeymap({
              hasGhost: () => !!propsRef.current.ghostText,
              acceptGhost: () => propsRef.current.onGhostAccept(),
              dismissGhost: () => propsRef.current.onGhostDismiss(),
              onSave: () => propsRef.current.onSave(),
              onToggleMode: () => propsRef.current.onToggleMode(),
              onAiContinue: () => propsRef.current.onAiContinue(),
              onCancel: () => propsRef.current.onCancel(),
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
                  wrapSelectionCmd(v, '[', '](url)')
                } else {
                  const linkText = 'text'
                  insertAtCursorCmd(v, `[${linkText}](url)`, { cursorOffset: linkText.length + 3 })
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
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return
              propsRef.current.onChange(update.state.doc.toString())
              // 用户输入（含粘贴/拖拽）取消 AI 续写 ghost
              if (
                propsRef.current.ghostText &&
                update.transactions.some(
                  (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'),
                )
              ) {
                propsRef.current.onGhostDismiss()
              }
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
        if ((window as unknown as { __cmView?: EditorView }).__cmView === view) {
          delete (window as unknown as { __cmView?: EditorView }).__cmView
        }
        view.destroy()
        viewRef.current = null
      }
    }, [])

    // 外部 value 变化（文档加载完成 / 草稿恢复）时整体替换文档内容
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (props.value !== current) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: props.value },
          selection: { anchor: props.value.length },
        })
      }
    }, [props.value])

    // ghostText 属性 → StateField 装饰
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const active = view.state.field(ghostTextState)
      if (props.ghostText === active) return
      view.dispatch({
        effects: props.ghostText ? setGhostText.of(props.ghostText) : clearGhostText.of(null),
      })
    }, [props.ghostText])

    return <div ref={hostRef} className="min-w-0 flex-1" />
  },
)

export default CodeMirrorEditor
