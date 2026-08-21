import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Pencil,
  ImageDown,
} from 'lucide-react'
import {
  parseMarkdownToBlocks,
  inputsToBlockTree,
  stripTitleFromMarkdown,
  clipContinuePrefix,
  clipContinueSuffix,
} from '@notefast/core'
import type { Block } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useToast } from './ui'
import { relativeTime } from '../lib/time'
import { useEditorDraft } from '../hooks/useEditorDraft'
import { useImageUploader } from '../hooks/useImageUploader'
import BlockRenderer from './BlockRenderer'
import EditorToolbar, { ShortcutsHelp } from './editor/EditorToolbar'
import { useDocContextMenu } from './editor/DocContextMenu'
import EditorFooter from './editor/EditorFooter'
import CodeMirrorEditor from './editor/CodeMirrorEditor'
import type { CodeMirrorEditorHandle } from './editor/CodeMirrorEditor'
import SelectionBubble from './editor/SelectionBubble'
import type { SelectionAnchor } from './editor/cm/selectionReport'
import { useAiWriting } from '../ai/useAiWriting'
import { useAiCapabilities } from '../hooks/useAiCapabilities'

interface MarkdownEditorProps {
  docId: string
  title?: string
  onSaved: () => void
  /** 每次保存成功（含自动保存）后回调，供历史面板等即时刷新 */
  onAutoSaved?: () => void
  autoEdit?: boolean
  onActiveChange?: (editing: boolean) => void
}

const CJK_WORDS_PER_MIN = 320

export default function MarkdownEditor({ docId, title, onSaved, onAutoSaved, autoEdit = false, onActiveChange }: MarkdownEditorProps) {
  const { t } = useTranslation()
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
        {t('mdEditor.edit')}
      </button>
    )
  }

  return <EditorInline docId={docId} title={title} onSaved={onSaved} onAutoSaved={onAutoSaved} onClose={() => setEditing(false)} />
}

type Mode = 'edit' | 'view'

function EditorInline({ docId, title, onSaved, onAutoSaved, onClose }: { docId: string; title?: string; onSaved: () => void; onAutoSaved?: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const draft = useEditorDraft(docId)
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState('')
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [draftedAt, setDraftedAt] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('edit')
  const [imageDragOver, setImageDragOver] = useState(false)
  const imageDragCounter = useRef(0)
  const [showHelp, setShowHelp] = useState(false)
  const [ghostText, setGhostText] = useState('')
  const ghostTextRef = useRef('')
  const editorRef = useRef<CodeMirrorEditorHandle>(null)
  // 选区气泡（桌面端）：非空选区锚点 + 改写预览（原文不动，接受后才替换）
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineRect, setRefineRect] = useState<SelectionAnchor['rect'] | null>(null)
  const [refineRange, setRefineRange] = useState<{ from: number; to: number } | null>(null)
  const refineRangeRef = useRef<{ from: number; to: number } | null>(null)

  const ai = useAiCapabilities()
  const aiWriting = useAiWriting()
  const continueGenRef = useRef(0)

  const lastSavedContentRef = useRef('')
  const serverUpdatedAtRef = useRef('')
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showRecoverDraft, setShowRecoverDraft] = useState(false)
  const recoverDraftContentRef = useRef<string | null>(null)

  const doSave = useCallback(async (markdown: string, checkpoint = false): Promise<boolean> => {
    try {
      // checkpoint=false（自动保存）→ 不记整篇快照，避免历史刷屏；
      // checkpoint=true（手动/切走/Ctrl+S）→ 记版本点，可回退
      const r = await api.put<{ doc: unknown; updated_at?: string }>(`/docs/${docId}/markdown`, { markdown, checkpoint })
      lastSavedContentRef.current = markdown
      if (r.updated_at) serverUpdatedAtRef.current = r.updated_at
      draft.clearDraft()
      setAutoSaveStatus('saved')
      onAutoSaved?.()
      return true
    } catch {
      draft.saveDraft(markdown, serverUpdatedAtRef.current)
      setAutoSaveStatus('error')
      return false
    }
  }, [docId, draft, onAutoSaved])

  const triggerAutoSave = useCallback((markdown: string, checkpoint?: boolean) => {
    if (markdown === lastSavedContentRef.current) return
    setAutoSaveStatus('saving')
    doSave(markdown, checkpoint ?? false)
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
    // 手动保存：记版本点（checkpoint=true）
    const ok = await doSave(content, true)
    if (ok) {
      setInitialContent(content)
      onSaved()
      onClose()
    } else {
      toast.error({
        title: t('mdEditor.saveFailed'),
        description: t('mdEditor.checkNetwork'),
      })
      setSaving(false)
    }
  }, [saving, content, doSave, onSaved, onClose, toast, t])

  const handleCancel = useCallback(() => {
    if (content !== lastSavedContentRef.current) {
      draft.saveDraft(content, serverUpdatedAtRef.current)
      // 切走/退出：强制记版本点（checkpoint=true），覆盖「看到已保存就离开」的场景，
      // 保证离开前这段编辑有可回退的历史
      triggerAutoSave(content, true)
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

  // ⌘P 必须在 window capture 拦下：浏览器/系统打印会抢 bubble 阶段；
  // 预览态会卸掉 CM，编辑态焦点也可能在工具栏，不能只绑编辑器 keymap。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'p') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setMode((m) => (m === 'edit' ? 'view' : 'edit'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const handleAiContinue = useCallback(() => {
    if (aiWriting.isStreaming) return
    if (!ai.chat) {
      toast.info({ title: t('doc.aiContinueNeedChat') })
      return
    }
    const split = editorRef.current?.getCursorSplit()
    const prefix = clipContinuePrefix(split?.prefix ?? content)
    const suffix = clipContinueSuffix(split?.suffix ?? '')
    if (!prefix.trim()) {
      toast.info({ title: t('editorToolbar.continueNeedPrefix') })
      return
    }
    refineRangeRef.current = null
    setRefineRange(null)
    setRefineRect(null)
    setRefining(false)
    ghostTextRef.current = ''
    setGhostText('')
    const gen = ++continueGenRef.current
    let accumulated = ''
    void aiWriting
      .streamContinue(prefix, {
        onToken: (token) => {
          if (continueGenRef.current !== gen) return
          accumulated += token
          ghostTextRef.current = accumulated
          setGhostText(accumulated)
        },
      }, { suffix })
      .catch(() => {
        if (continueGenRef.current !== gen) return
        ghostTextRef.current = ''
        setGhostText('')
        toast.error({ title: t('aiWrite.failed') })
      })
  }, [ai.chat, content, aiWriting, toast, t])

  // AI ghost：续写插在光标；改写替换选区。Tab 接受，Esc / 输入取消。
  const handleGhostAccept = useCallback(() => {
    const text = ghostTextRef.current
    if (!text) return
    const range = refineRangeRef.current
    continueGenRef.current += 1
    aiWriting.cancel()
    ghostTextRef.current = ''
    setGhostText('')
    refineRangeRef.current = null
    setRefineRange(null)
    setRefineRect(null)
    setRefining(false)
    if (range) editorRef.current?.replaceRange(range.from, range.to, text)
    else editorRef.current?.insertAtCursor(text)
  }, [aiWriting])

  const handleGhostDismiss = useCallback(() => {
    continueGenRef.current += 1
    aiWriting.cancel()
    ghostTextRef.current = ''
    setGhostText('')
    refineRangeRef.current = null
    setRefineRange(null)
    setRefineRect(null)
    setRefining(false)
  }, [aiWriting])

  // ── 选区气泡：问 AI / 改写预览（原文不动） ──

  const handleSelectionChange = useCallback((anchor: SelectionAnchor | null) => {
    setSelAnchor(anchor)
  }, [])

  const handleRefineStop = useCallback(() => {
    aiWriting.cancel()
    setRefining(false)
    if (!ghostTextRef.current) {
      refineRangeRef.current = null
      setRefineRange(null)
      setRefineRect(null)
    }
  }, [aiWriting])

  const handleBubbleDismiss = useCallback(() => {
    if (refineRangeRef.current || ghostTextRef.current) {
      handleGhostDismiss()
      return
    }
    setSelAnchor(null)
  }, [handleGhostDismiss])

  const handleBubbleRefine = useCallback(
    (anchor: SelectionAnchor) => {
      if (!anchor.text.trim()) return
      handleGhostDismiss()
      const range = { from: anchor.from, to: anchor.to }
      refineRangeRef.current = range
      setRefineRange(range)
      setRefineRect(anchor.rect)
      setRefining(true)
      setSelAnchor(null)
      const gen = ++continueGenRef.current
      const prefix = clipContinuePrefix(content.slice(0, anchor.from))
      const suffix = clipContinueSuffix(content.slice(anchor.to))
      let accumulated = ''
      void aiWriting
        .streamRefine(anchor.text, '', {
          onToken: (token) => {
            if (continueGenRef.current !== gen) return
            accumulated += token
            ghostTextRef.current = accumulated
            setGhostText(accumulated)
          },
        }, { prefix, suffix })
        .then(() => {
          if (continueGenRef.current !== gen) return
          setRefining(false)
          if (!accumulated) {
            refineRangeRef.current = null
            setRefineRange(null)
            setRefineRect(null)
          }
        })
        .catch(() => {
          if (continueGenRef.current !== gen) return
          ghostTextRef.current = ''
          setGhostText('')
          refineRangeRef.current = null
          setRefineRange(null)
          setRefineRect(null)
          setRefining(false)
          toast.error({ title: t('selectionBubble.refineFailed') })
        })
    },
    [aiWriting, handleGhostDismiss, content, toast, t],
  )

  const handleEditorChange = useCallback((value: string) => {
    setContent(value)
  }, [])

  const { lines, charCount, readMin } = useMemo(() => {
    let lines = 1
    let cjkCount = 0
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i)
      if (code === 10) lines++
      if (code >= 0x4e00 && code <= 0x9fff) cjkCount++
    }
    const charCount = content.length
    const enCount = charCount - cjkCount
    const words = cjkCount + Math.floor(enCount / 5)
    const readMin = words <= 0 ? 0 : Math.max(1, Math.round(words / CJK_WORDS_PER_MIN))
    return { lines, charCount, words, readMin }
  }, [content])
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

  const previewTree: Block | null = useMemo(() => {
    if (mode !== 'view' || !content) return null
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
  }, [mode, content])

  // 预览态自定义右键菜单（与 routes/doc.tsx 同步：依靠 data-block-id 查回 Block）
  const ctxMenu = useDocContextMenu({ rootBlock: previewTree, disabled: mode !== 'view' })

  return (
    <div className="animate-fade-in">
      <EditorToolbar
        mode={mode}
        saving={saving}
        loading={loading}
        uploadingImage={imageUploader.uploading}
        uploadProgress={imageUploader.progress}
        showHelp={showHelp}
        onToggleHelp={setShowHelp}
        onSave={handleSave}
        onCancel={handleCancel}
        insertAtCursor={insertAtCursor}
        wrapSelection={wrapSelection}
        uploadImage={imageUploader.uploadImage}
        editorRef={editorRef}
        aiContinue={{
          available: ai.chat,
          streaming: aiWriting.isStreaming && !refineRange,
          hasDraft: !!ghostText && !refineRange,
          onStart: handleAiContinue,
          onAccept: handleGhostAccept,
          onStop: () => {
            aiWriting.cancel()
          },
          onDiscard: handleGhostDismiss,
        }}
      />

      {loading ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" />
          {t('mdEditor.loadingDoc')}
        </div>
      ) : (
        <>
          {showRecoverDraft && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px]">
              <span className="flex-1 text-muted-foreground">
                {t('mdEditor.draftNotice')}
              </span>
              <button
                type="button"
                onClick={handleRecoverDraft}
                className="font-medium text-primary hover:text-primary/80 transition-colors"
              >
                {t('mdEditor.recoverDraft')}
              </button>
              <button
                type="button"
                onClick={handleDismissRecoverDraft}
                className="text-muted-foreground/60 hover:text-destructive transition-colors"
              >
                {t('mdEditor.discard')}
              </button>
            </div>
          )}

          {mode === 'view' ? (
            <div
              className="min-h-[200px]"
              onContextMenu={ctxMenu.onContextMenu}
              onKeyDown={ctxMenu.onKeyDown}
            >
              {previewTree ? (
                <>
                  <BlockRenderer block={previewTree} />
                  {ctxMenu.menu}
                </>
              ) : (
                <div className="text-sm text-muted-foreground/70 italic py-4">{t('mdEditor.emptyPreview')}</div>
              )}
            </div>
          ) : (
            <>
              <div
              className="relative"
              onDragEnter={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault()
                  imageDragCounter.current += 1
                  setImageDragOver(true)
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }
              }}
              onDragLeave={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  imageDragCounter.current = Math.max(0, imageDragCounter.current - 1)
                  if (imageDragCounter.current === 0) setImageDragOver(false)
                }
              }}
              onDrop={() => {
                // CodeMirror 的 domEventHandlers 还会接走这个 drop 并调 onImageFile；
                // 这里只重置拖拽状态
                imageDragCounter.current = 0
                setImageDragOver(false)
              }}
            >
              <CodeMirrorEditor
                ref={editorRef}
                value={content}
                onChange={handleEditorChange}
                onSave={handleSave}
                onAiContinue={handleAiContinue}
                onImageFile={imageUploader.uploadImage}
                ghostText={ghostText}
                ghostHint={t('editorToolbar.continueGhostHint')}
                ghostRange={refineRange ?? undefined}
                onGhostAccept={handleGhostAccept}
                onGhostDismiss={handleGhostDismiss}
                onSelectionChange={handleSelectionChange}
                autoFocus
                placeholder={t('mdEditor.placeholder')}
              />
              {/* 图片拖入反馈：拖拽文件进入区域时铺底高亮，提示“松开即上传”。
                  CM 的 domEventHandlers 仍然处理 drop、CodeMirrorFocus 里调 uploadImage。 */}
              {imageDragOver && (
                <div
                  role="status"
                  aria-live="polite"
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/8 border-2 border-dashed border-primary/40 rounded-md animate-fade-in"
                >
                  <div className="flex flex-col items-center gap-2 text-primary">
                    <ImageDown className="w-7 h-7" strokeWidth={1.5} />
                    <span className="text-[13px] font-medium">
                      {t('mdEditor.dropImageHint', { defaultValue: '松开上传图片' })}
                    </span>
                  </div>
                </div>
              )}
            </div>
              <SelectionBubble
                anchor={selAnchor}
                refining={refining}
                refineRect={refineRect}
                hasDraft={!!ghostText && !!refineRange}
                onRefine={handleBubbleRefine}
                onAccept={handleGhostAccept}
                onStopRefine={handleRefineStop}
                onDismiss={handleBubbleDismiss}
              />
            </>
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
          <ShortcutsHelp keys={['mod', 'S']} desc={t('mdEditor.helpSave')} />
          <ShortcutsHelp keys={['mod', 'P']} desc={t('mdEditor.helpTogglePreview')} />
          <ShortcutsHelp keys={['mod', 'B']} desc={t('mdEditor.helpBold')} />
          <ShortcutsHelp keys={['mod', 'I']} desc={t('mdEditor.helpItalic')} />
          <ShortcutsHelp keys={['mod', 'E']} desc={t('mdEditor.helpInlineCode')} />
          <ShortcutsHelp keys={['mod', '⇧K']} desc={t('mdEditor.helpInsertLink')} />
          <ShortcutsHelp keys={['mod', 'Enter']} desc={t('mdEditor.helpAiContinue')} />
          <ShortcutsHelp keys={['Tab']} desc={t('mdEditor.helpAiAccept')} />
          <p className="col-span-2 mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {t('mdEditor.helpEditingTips')}
          </p>
        </div>
      )}
    </div>
  )
}
