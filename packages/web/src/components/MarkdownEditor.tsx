import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Loader2,
  Pencil,
} from 'lucide-react'
import { parseMarkdownToBlocks, inputsToBlockTree, stripTitleFromMarkdown } from '@notefast/core'
import type { Block } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useToast } from './ui'
import { relativeTime } from '../lib/time'
import { useEditorDraft } from '../hooks/useEditorDraft'
import { useEditorKeyboard } from '../hooks/useEditorKeyboard'
import { useImageUploader } from '../hooks/useImageUploader'
import BlockRenderer from './BlockRenderer'
import EditorToolbar, { ShortcutsHelp } from './editor/EditorToolbar'
import EditorFooter from './editor/EditorFooter'
import AiGhostOverlay from './editor/AiGhostOverlay'
import { useAiWriting } from '../ai/useAiWriting'

interface MarkdownEditorProps {
  docId: string
  title?: string
  onSaved: () => void
  autoEdit?: boolean
  onActiveChange?: (editing: boolean) => void
}

const CJK_WORDS_PER_MIN = 320

export default function MarkdownEditor({ docId, title, onSaved, autoEdit = false, onActiveChange }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(autoEdit)

  useEffect(() => {
    onActiveChange?.(editing)
  }, [editing, onActiveChange])

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground bg-card border border-border rounded-md transition-colors"
      >
        <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
        编辑
      </button>
    )
  }

  return <EditorInline docId={docId} title={title} onSaved={onSaved} onClose={() => setEditing(false)} />
}

type Mode = 'edit' | 'view'

function EditorInline({ docId, title, onSaved, onClose }: { docId: string; title?: string; onSaved: () => void; onClose: () => void }) {
  const toast = useToast()
  const draft = useEditorDraft(docId)
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState('')
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [draftedAt, setDraftedAt] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('edit')
  const [showHelp, setShowHelp] = useState(false)
  const [ghostText, setGhostText] = useState('')
  const [cursorLine, setCursorLine] = useState(1)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const aiWriting = useAiWriting()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const saved = draft.loadDraft()
    if (saved !== null) {
      setContent(saved)
      setInitialContent(saved)
      setDraftedAt(new Date())
      setLoadedAt(new Date())
      setLoading(false)
      return
    }
    api.get<{ markdown: string }>(`/docs/${docId}/export/markdown`)
      .then((r) => {
        if (cancelled) return
        const raw = r.markdown || ''
        const md = title ? stripTitleFromMarkdown(raw, title) : raw
        setContent(md)
        setInitialContent(md)
        setLoadedAt(new Date())
      })
      .catch(() => { if (!cancelled) setContent('') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [docId, title])

  useEffect(() => {
    if (!loading && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [loading])

  useEffect(() => {
    if (!loadedAt) return
    if (content === initialContent) return
    const id = setTimeout(() => {
      draft.saveDraft(content)
      setDraftedAt(new Date())
    }, 600)
    return () => clearTimeout(id)
  }, [content, docId, initialContent, loadedAt])

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta || mode !== 'edit') return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [content, mode, loading])

  const insertAtCursor = useCallback(
    (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = content.slice(0, start)
      const after = content.slice(end)
      const newValue = before + text + after
      setContent(newValue)
      const cursorOffset = opts?.cursorOffset ?? text.length
      const cursorPos = start + cursorOffset
      requestAnimationFrame(() => {
        ta.focus()
        if (opts?.selectStart !== undefined) {
          ta.setSelectionRange(start + opts.selectStart, start + opts.selectStart)
        } else {
          ta.setSelectionRange(cursorPos, cursorPos)
        }
      })
    },
    [content],
  )

  const wrapSelection = useCallback(
    (leftWrap: string, rightWrap: string = leftWrap) => {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = content.slice(0, start)
      const middle = content.slice(start, end)
      const after = content.slice(end)
      const newValue = before + leftWrap + middle + rightWrap + after
      setContent(newValue)
      requestAnimationFrame(() => {
        ta.focus()
        if (start === end) {
          ta.setSelectionRange(start + leftWrap.length, start + leftWrap.length)
        } else {
          ta.setSelectionRange(start + leftWrap.length, end + leftWrap.length)
        }
      })
    },
    [content],
  )

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await api.put(`/docs/${docId}/markdown`, { markdown: content })
      setInitialContent(content)
      draft.clearDraft()
      onSaved()
      onClose()
    } catch (e) {
      draft.saveDraft(content)
      toast.error({
        title: '保存失败',
        description: e instanceof Error ? e.message : String(e),
      })
      setSaving(false)
    }
  }, [saving, content, docId, onSaved, onClose, toast])

  const handleCancel = useCallback(() => {
    draft.saveDraft(content)
    onClose()
  }, [docId, content, onClose])

  const imageUploader = useImageUploader({ insertAtCursor })

  const handleAiContinue = useCallback(() => {
    if (aiWriting.isStreaming) return
    let accumulated = ''
    void aiWriting.streamContinue(content, {
      onToken: (token) => {
        accumulated += token
        setGhostText(accumulated)
      },
    }).catch(() => {
      setGhostText('')
    })
  }, [content, aiWriting])

  const { handleKeyDown } = useEditorKeyboard({
    content,
    mode,
    onSave: handleSave,
    onCancel: handleCancel,
    onSetMode: setMode,
    wrapSelection,
    insertAtCursor,
    setContent,
    textareaRef,
    onAiContinue: handleAiContinue,
  })

  const handleKeyDownWithGhost = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ghostText) {
        if (e.key === 'Tab') {
          e.preventDefault()
          insertAtCursor(ghostText)
          setGhostText('')
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          aiWriting.cancel()
          setGhostText('')
          return
        }
        if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
          aiWriting.cancel()
          setGhostText('')
        }
      }
      handleKeyDown(e)
    },
    [ghostText, handleKeyDown, insertAtCursor, aiWriting],
  )

  // 光标所在逻辑行（1 起），用于行号槽高亮；只跟踪行号，不渲染整行背景——
  // textarea 软换行会让逻辑行与视觉行错位，整行背景需要对齐测量，易引入抖动
  const updateCursorLine = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    setCursorLine(ta.value.slice(0, ta.selectionStart).split('\n').length)
  }, [])

  const lines = content === '' ? 1 : content.split('\n').length
  const charCount = content.length
  const cjkCount = (content.match(/[\u4e00-\u9fff]/g) || []).length
  const enCount = content.length - cjkCount
  const words = cjkCount + Math.floor(enCount / 5)
  const readMin = words <= 0 ? 0 : Math.max(1, Math.round(words / CJK_WORDS_PER_MIN))
  const dirty = content !== initialContent

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const previewTree: Block | null = mode === 'view' && content
    ? (() => {
        try {
          const inputs = parseMarkdownToBlocks(content, '__preview__')
          const children = inputsToBlockTree(inputs)
          if (children.length === 0) return null
          return {
            id: '__preview__',
            notebook_id: '__preview__',
            parent_id: null,
            root_id: '__preview__',
            type: 'document',
            content: '',
            properties: {},
            sort: 0,
            level: 0,
            created_at: '',
            updated_at: '',
            children,
          } as Block
        } catch {
          return null
        }
      })()
    : null

  return (
    <div className="animate-fade-in">
      <EditorToolbar
        mode={mode}
        onModeToggle={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
        saving={saving}
        loading={loading}
        uploadingImage={imageUploader.uploading}
        showHelp={showHelp}
        onToggleHelp={setShowHelp}
        onSave={handleSave}
        onCancel={handleCancel}
        insertAtCursor={insertAtCursor}
        wrapSelection={wrapSelection}
        uploadImage={imageUploader.uploadImage}
        content={content}
        textareaRef={textareaRef}
      />

      {loading ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" />
          加载文档…
        </div>
      ) : mode === 'view' ? (
        <div className="min-h-[200px]">
          {previewTree ? (
            <BlockRenderer block={previewTree} />
          ) : (
            <div className="text-sm text-muted-foreground/70 italic py-4">（空文档，无法预览）</div>
          )}
        </div>
      ) : (
        <div className="flex items-start relative">
          <div
            aria-hidden
            className="shrink-0 w-7 pr-3 pt-[7px] text-right font-mono text-[11px] leading-[1.75] text-muted-foreground/35 select-none tabular-nums"
          >
            {Array.from({ length: lines }, (_, i) => (
              <div key={i + 1} className={i + 1 === cursorLine ? 'text-muted-foreground' : undefined}>
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onSelect={updateCursorLine}
            onKeyDown={handleKeyDownWithGhost}
            onPaste={imageUploader.handlePaste}
            onDrop={imageUploader.handleDrop}
            onDragOver={(e) => e.preventDefault()}
            spellCheck={false}
            rows={Math.max(lines, 5)}
            className="flex-1 min-w-0 pt-[7px] pb-16 font-mono text-[14px] leading-[1.75] text-foreground bg-transparent resize-none overflow-hidden focus:outline-none placeholder:text-muted-foreground/40 selection:bg-primary/15"
            placeholder="开始写…（⌘B 加粗 / ⌘I 斜体 / # 标题 / - 列表；⌘P 预览；⌘S 保存）"
          />
          <AiGhostOverlay
            textareaRef={textareaRef}
            content={content}
            ghostText={ghostText}
            visible={!!ghostText}
          />
        </div>
      )}

      <EditorFooter
        charCount={charCount}
        lines={lines}
        readMin={readMin}
        dirty={dirty}
        draftedAt={draftedAt}
        hasDraft={draft.hasDraft()}
        onClearDraft={() => { draft.clearDraft(); window.location.reload() }}
        onAppendFile={insertAtCursor}
        relativeTime={relativeTime}
      />

      {showHelp && (
        <div className="mt-3 pt-3 border-t border-border/50 text-[11.5px] text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1.5">
          <ShortcutsHelp kbd="⌘ S" desc="保存" />
          <ShortcutsHelp kbd="⌘ P" desc="切换 预览 / 编辑" />
          <ShortcutsHelp kbd="⌘ B / I / E" desc="加粗 / 斜体 / 行内代码" />
          <ShortcutsHelp kbd="⌘⇧ K" desc="插入链接" />
          <ShortcutsHelp kbd="⌘ Enter" desc="AI 续写（需配置 AI）" />
          <ShortcutsHelp kbd="# Enter" desc="自动加 heading 触发器" />
          <ShortcutsHelp kbd="- Enter" desc="自动加 list 触发器" />
          <ShortcutsHelp kbd="Esc" desc="退出（保留草稿）" />
        </div>
      )}
    </div>
  )
}
