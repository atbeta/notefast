import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Pencil,
  ImageDown,
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
import { useDocContextMenu } from './editor/DocContextMenu'
import EditorFooter from './editor/EditorFooter'
import CodeMirrorEditor from './editor/CodeMirrorEditor'
import type { CodeMirrorEditorHandle } from './editor/CodeMirrorEditor'
import SelectionBubble from './editor/SelectionBubble'
import type { SelectionAnchor } from './editor/cm/selectionReport'
import { RefineSession } from './editor/refineSession'
import { useAiWriting } from '../ai/useAiWriting'

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
  const editorRef = useRef<CodeMirrorEditorHandle>(null)
  // 选区气泡（桌面端）：非空选区锚点 + 改写流式会话
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineRect, setRefineRect] = useState<SelectionAnchor['rect'] | null>(null)
  const refineSessionRef = useRef<RefineSession | null>(null)

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
      onAutoSaved?.()
      return true
    } catch {
      draft.saveDraft(markdown, serverUpdatedAtRef.current)
      setAutoSaveStatus('error')
      return false
    }
  }, [docId, draft, onAutoSaved])

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
        title: t('mdEditor.saveFailed'),
        description: t('mdEditor.checkNetwork'),
      })
      setSaving(false)
    }
  }, [saving, content, doSave, onSaved, onClose, toast, t])

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
    if (aiWriting.isStreaming || refineSessionRef.current) return
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

  // ── 选区气泡：问 AI / 改写流式原地替换 ──

  const handleSelectionChange = useCallback((anchor: SelectionAnchor | null) => {
    setSelAnchor(anchor)
  }, [])

  const endRefine = useCallback(() => {
    refineSessionRef.current = null
    setRefining(false)
    setRefineRect(null)
  }, [])

  const handleRefineStop = useCallback(() => {
    endRefine()
    aiWriting.cancel()
  }, [endRefine, aiWriting])

  const handleBubbleDismiss = useCallback(() => {
    setSelAnchor(null)
  }, [])

  const handleBubbleRefine = useCallback(
    (anchor: SelectionAnchor) => {
      if (refineSessionRef.current) return
      // 改写接管续写：取消进行中的 ghost 续写流
      handleGhostDismiss()
      const session = new RefineSession(anchor.from, anchor.to, (from, to, text) => {
        editorRef.current?.replaceRange(from, to, text)
      })
      refineSessionRef.current = session
      setRefineRect(anchor.rect)
      setRefining(true)
      setSelAnchor(null)
      let accumulated = ''
      // instruction 传空串 = 通用润色（useAiWriting 对空串不下发该字段；服务端跟随内容语言）
      void aiWriting
        .streamRefine(anchor.text, '', {
          onToken: (token) => {
            if (refineSessionRef.current !== session) return
            accumulated += token
            session.apply(accumulated)
          },
        })
        .then(() => {
          if (refineSessionRef.current === session) endRefine()
        })
        .catch(() => {
          // 主动取消 / 外部编辑中断：会话已不在，静默（保留已替换内容）
          if (refineSessionRef.current !== session) return
          endRefine()
          toast.error({ title: t('selectionBubble.refineFailed') })
        })
    },
    [aiWriting, endRefine, handleGhostDismiss, toast, t],
  )

  // 改写流式期间的外部编辑（非 session.apply 自身的 dispatch）：取消流，保留已替换内容
  const handleEditorChange = useCallback(
    (value: string) => {
      setContent(value)
      const session = refineSessionRef.current
      if (session && session.isExternalEdit()) {
        endRefine()
        aiWriting.cancel()
      }
    },
    [endRefine, aiWriting],
  )

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

  // 预览态自定义右键菜单（与 routes/doc.tsx 同步：依靠 data-block-id 查回 Block）
  const ctxMenu = useDocContextMenu({ rootBlock: previewTree, disabled: mode !== 'view' })

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
                onToggleMode={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
                onAiContinue={handleAiContinue}
                onCancel={handleCancel}
                onImageFile={imageUploader.uploadImage}
                ghostText={ghostText}
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
                onRefine={handleBubbleRefine}
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
          <ShortcutsHelp keys={['-', 'Enter']} desc={t('mdEditor.helpListContinue')} />
          <ShortcutsHelp keys={['```', 'Enter']} desc={t('mdEditor.helpCodeBlock')} />
          <ShortcutsHelp keys={['Esc']} desc={t('mdEditor.helpExit')} />
        </div>
      )}
    </div>
  )
}
