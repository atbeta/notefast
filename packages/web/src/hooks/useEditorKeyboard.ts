import { useCallback, useEffect } from 'react'

const BLOCK_TRIGGER = /^(\s*)(?:#{1,6}|>|[-+*]\s|\d+\.\s|```)\s$/

interface EditorKeyboardOpts {
  content: string
  mode: 'edit' | 'view'
  onSave: () => void
  onCancel: () => void
  onSetMode: React.Dispatch<React.SetStateAction<'edit' | 'view'>>
  wrapSelection: (left: string, right?: string) => void
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
  setContent: (text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onAiContinue?: () => void
}

export function useEditorKeyboard({
  content,
  mode,
  onSave,
  onCancel,
  onSetMode,
  wrapSelection,
  insertAtCursor,
  setContent,
  textareaRef,
  onAiContinue,
}: EditorKeyboardOpts) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSave()
        return
      }
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        onSetMode((m) => (m === 'edit' ? 'view' : 'edit'))
        return
      }
      if (mod && e.key === 'Enter' && onAiContinue) {
        e.preventDefault()
        onAiContinue()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const sel = content.slice(ta.selectionStart, ta.selectionEnd)
        const hasSel = sel.length > 0
        if (hasSel) {
          wrapSelection('[', '](url)')
        } else {
          const linkText = 'text'
          const ins = `[${linkText}](url)`
          insertAtCursor(ins, { cursorOffset: linkText.length + 3 })
        }
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        const { selectionStart, value } = ta
        if (selectionStart === ta.selectionEnd) {
          const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
          const currentLine = value.slice(lineStart, selectionStart)
          const m = currentLine.match(BLOCK_TRIGGER)
          if (m) {
            e.preventDefault()
            if (m[2] === '```' && /^\s*```/.test(value.slice(value.lastIndexOf('\n', selectionStart - 2), lineStart))) {
              const exit = value.slice(0, selectionStart) + '\n```\n' + value.slice(selectionStart)
              setContent(exit)
              requestAnimationFrame(() => {
                const pos = selectionStart + 5
                ta.setSelectionRange(pos, pos)
              })
              return
            }
            const fullPrefix = m[1] + m[2] + (m[2]?.endsWith(' ') ? '' : ' ')
            const before = value.slice(0, selectionStart)
            const after = value.slice(selectionStart)
            const insert = '\n' + fullPrefix
            const newPos = selectionStart + insert.length
            const newValue = before + insert + after
            setContent(newValue)
            requestAnimationFrame(() => ta.setSelectionRange(newPos, newPos))
            return
          }
          const emptyList = /^(\s*)([-+*]|>)\s*$/.exec(currentLine)
          if (emptyList) {
            e.preventDefault()
            const before = value.slice(0, lineStart)
            const after = value.slice(selectionStart)
            setContent(before + after)
            requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart))
            return
          }
        }
      }

      const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
      const pair = PAIRS[e.key]
      if (pair) {
        const { selectionStart, selectionEnd, value } = ta
        if (selectionStart === selectionEnd) {
          const next = value[selectionStart]
          if (next === pair) {
            e.preventDefault()
            ta.setSelectionRange(selectionStart + 1, selectionStart + 1)
            return
          }
          e.preventDefault()
          const newValue = value.slice(0, selectionStart) + e.key + pair + value.slice(selectionEnd)
          setContent(newValue)
          requestAnimationFrame(() => ta.setSelectionRange(selectionStart + 1, selectionStart + 1))
          return
        }
        e.preventDefault()
        const inner = value.slice(selectionStart, selectionEnd)
        const newValue = value.slice(0, selectionStart) + e.key + inner + pair + value.slice(selectionEnd)
        setContent(newValue)
        requestAnimationFrame(() => ta.setSelectionRange(selectionEnd + 2, selectionEnd + 2))
        return
      }

      if (e.key === 'Backspace' && !mod) {
        const { selectionStart, selectionEnd, value } = ta
        if (selectionStart === selectionEnd && selectionStart > 0) {
          const left = value[selectionStart - 1]
          const right = value[selectionStart]
          const PAIRS2: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
          if (PAIRS2[left] === right) {
            e.preventDefault()
            const newValue = value.slice(0, selectionStart - 1) + value.slice(selectionStart + 1)
            setContent(newValue)
            requestAnimationFrame(() => ta.setSelectionRange(selectionStart - 1, selectionStart - 1))
            return
          }
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    },
    [content, mode, onSave, onCancel, onSetMode, wrapSelection, insertAtCursor, setContent, onAiContinue],
  )

  const handleShortcutKey = useCallback(
    (e: KeyboardEvent) => {
      const ta = textareaRef.current
      if (!ta) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (document.activeElement !== ta) return
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); wrapSelection('**', '**'); return }
      if (k === 'i') { e.preventDefault(); wrapSelection('*', '*'); return }
      if (k === 'e') { e.preventDefault(); wrapSelection('`', '`'); return }
    },
    [wrapSelection, textareaRef],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [handleShortcutKey])

  return { handleKeyDown }
}
