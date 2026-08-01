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
import { useImageUploader } from '../hooks/useImageUploader'
import BlockRenderer from './BlockRenderer'
import EditorToolbar, { ShortcutsHelp } from './editor/EditorToolbar'
import EditorFooter from './editor/EditorFooter'
import CodeMirrorEditor from './editor/CodeMirrorEditor'
import type { CodeMirrorEditorHandle } from './editor/CodeMirrorEditor'
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
  const editorRef = useRef<CodeMirrorEditorHandle>(null)

  const aiWriting = useAiWriting()

  const lastSavedContentRef = useRef('')
  const serverUpdatedAtRef = useRef('')
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showRecoverDraft, setShowRecoverDraft] = useState(false)
  const recoverDraftContentRef = useRef<string | null>(null)

  const doSave = useCallback(async (markdown: string): Promise<boolean> => {
    try {
      const r = await api.put<{ doc: unknown; updated_at?: string }>(`/docs/${docId}/markdown`, { markdown })
      lastSavedContentRef.current = markdown
      if (r.updated_at) serverUpdatedAtRef.current = r.updated_at
      draft.clearDraft()
      setAutoSaveStatus('saved')
      return true
    } catch {
      draft.saveDraft(markdown, serverUpdatedAtRef.current)
      setAutoSaveStatus('error')
      return false
    }
  }, [docId, draft])

  const triggerAutoSave = useCallback((markdown: string) => {
    if (markdown === lastSavedContentRef.current) return
    setAutoSaveStatus('saving')
    doSave(markdown)
  }, [doSave])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    api.get<{ markdown: string; updated_at?: string }>(`/docs/${docId}/export/markdown`)
      .then((r) => {
        if (cancelled) return
        const raw = r.markdown || ''
        const md = title ? stripTitleFromMarkdown(raw, title) : raw
        const serverUpdatedAt = r.updated_at ?? ''

        const draftPayload = draft.getDraftPayload()

        if (draftPayload && draftPayload.content !== md) {
          if (draftPayload.serverUpdatedAt && draftPayload.serverUpdatedAt === serverUpdatedAt) {
            setContent(draftPayload.content)
            setInitialContent(draftPayload.content)
            lastSavedContentRef.current = md
            serverUpdatedAtRef.current = serverUpdatedAt
            setDraftedAt(new Date(draftPayload.updatedAt))
            setLoadedAt(new Date())
            setLoading(false)
            return
          }
          recoverDraftContentRef.current = draftPayload.content
          setShowRecoverDraft(true)
        }

        setContent(md)
        setInitialContent(md)
        lastSavedContentRef.current = md
        serverUpdatedAtRef.current = serverUpdatedAt
        setLoadedAt(new Date())
      })
      .catch(() => {
        if (cancelled) return
        const saved = draft.loadDraft()
        if (saved !== null) {
          setContent(saved)
          setInitialContent(saved)
          lastSavedContentRef.current = saved
          setDraftedAt(new Date())
        } else {
          setContent('')
          setInitialContent('')
        }
        setLoadedAt(new Date())
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [docId, title])

  useEffect(() => {
    if (!loadedAt) return
    if (content === lastSavedContentRef.current) return

    const id = setTimeout(() => {
      draft.saveDraft(content, serverUpdatedAtRef.current)
      setDraftedAt(new Date())
    }, 600)
    return () => clearTimeout(id)
  }, [content, docId, loadedAt])

  useEffect(() => {
    if (!loadedAt) return
    if (content === lastSavedContentRef.current) return

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      triggerAutoSave(content)
    }, 3000)

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [content, loadedAt, triggerAutoSave])

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [])

  const insertAtCursor = useCallback(
    (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => {
      editorRef.current?.insertAtCursor(text, opts)
    },
    [],
  )

  const wrapSelection = useCallback((leftWrap: string, rightWrap: string = leftWrap) => {
    editorRef.current?.wrapSelection(leftWrap, rightWrap)
  }, [])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    const ok = await doSave(content)
    if (ok) {
      setInitialContent(content)
      onSaved()
      onClose()
    } else {
      toast.error({
        title: '保存失败',
        description: '请检查网络连接后重试',
      })
      setSaving(false)
    }
  }, [saving, content, doSave, onSaved, onClose, toast])

  const handleCancel = useCallback(() => {
    if (content !== lastSavedContentRef.current) {
      draft.saveDraft(content, serverUpdatedAtRef.current)
      triggerAutoSave(content)
    }
    onClose()
  }, [content, draft, triggerAutoSave, onClose])

  const handleRecoverDraft = useCallback(() => {
    const recovered = recoverDraftContentRef.current
    if (recovered !== null) {
      setContent(recovered)
      setInitialContent(recovered)
    }
    setShowRecoverDraft(false)
    recoverDraftContentRef.current = null
  }, [])

  const handleDismissRecoverDraft = useCallback(() => {
    draft.clearDraft()
    setShowRecoverDraft(false)
    recoverDraftContentRef.current = null
  }, [draft])

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

  // AI 续写 ghost：Tab 接受（插入光标处），Esc / 任意输入取消（由 CM keymap 与 updateListener 触发）
  const handleGhostAccept = useCallback(() => {
    if (!ghostText) return
    editorRef.current?.insertAtCursor(ghostText)
    setGhostText('')
  }, [ghostText])

  const handleGhostDismiss = useCallback(() => {
    aiWriting.cancel()
    setGhostText('')
  }, [aiWriting])

  const lines = content === '' ? 1 : content.split('\n').length
  const charCount = content.length
  const cjkCount = (content.match(/[\u4e00-\u9fff]/g) || []).length
  const enCount = content.length - cjkCount
  const words = cjkCount + Math.floor(enCount / 5)
  const readMin = words <= 0 ? 0 : Math.max(1, Math.round(words / CJK_WORDS_PER_MIN))
  const dirty = content !== initialContent
  const unsavedToServer = content !== lastSavedContentRef.current

  useEffect(() => {
    if (!unsavedToServer) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [unsavedToServer])

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
        editorRef={editorRef}
      />

      {loading ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" />
          加载文档…
        </div>
      ) : (
        <>
          {showRecoverDraft && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px]">
              <span className="flex-1 text-muted-foreground">
                有未保存的本地草稿（可能在其他设备编辑前遗留）
              </span>
              <button
                type="button"
                onClick={handleRecoverDraft}
                className="font-medium text-primary hover:text-primary/80 transition-colors"
              >
                恢复草稿
              </button>
              <button
                type="button"
                onClick={handleDismissRecoverDraft}
                className="text-muted-foreground/60 hover:text-destructive transition-colors"
              >
                丢弃
              </button>
            </div>
          )}

          {mode === 'view' ? (
            <div className="min-h-[200px]">
              {previewTree ? (
                <BlockRenderer block={previewTree} />
              ) : (
                <div className="text-sm text-muted-foreground/70 italic py-4">（空文档，无法预览）</div>
              )}
            </div>
          ) : (
            <CodeMirrorEditor
              ref={editorRef}
              value={content}
              onChange={setContent}
              onSave={handleSave}
              onToggleMode={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
              onAiContinue={handleAiContinue}
              onCancel={handleCancel}
              onImageFile={imageUploader.uploadImage}
              ghostText={ghostText}
              onGhostAccept={handleGhostAccept}
              onGhostDismiss={handleGhostDismiss}
              autoFocus
              placeholder="开始写…（⌘B 加粗 / ⌘I 斜体 / # 标题 / - 列表；⌘P 预览；⌘S 保存）"
            />
          )}
        </>
      )}

      <EditorFooter
        charCount={charCount}
        lines={lines}
        readMin={readMin}
        dirty={dirty}
        draftedAt={draftedAt}
        hasDraft={draft.hasDraft()}
        onClearDraft={() => { draft.clearDraft() }}
        onAppendFile={insertAtCursor}
        relativeTime={relativeTime}
        autoSaveStatus={autoSaveStatus}
      />

      {showHelp && (
        <div className="mt-3 pt-3 border-t border-border/50 text-[11.5px] text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1.5">
          <ShortcutsHelp keys={['mod', 'S']} desc="保存" />
          <ShortcutsHelp keys={['mod', 'P']} desc="切换 预览 / 编辑" />
          <ShortcutsHelp keys={['mod', 'B']} desc="加粗" />
          <ShortcutsHelp keys={['mod', 'I']} desc="斜体" />
          <ShortcutsHelp keys={['mod', 'E']} desc="行内代码" />
          <ShortcutsHelp keys={['mod', '⇧K']} desc="插入链接" />
          <ShortcutsHelp keys={['mod', 'Enter']} desc="AI 续写（需配置 AI）" />
          <ShortcutsHelp keys={['-', 'Enter']} desc="列表/引用续行（空项回车退出）" />
          <ShortcutsHelp keys={['```', 'Enter']} desc="展开空代码块" />
          <ShortcutsHelp keys={['Esc']} desc="退出（保留草稿）" />
        </div>
      )}
    </div>
  )
}
