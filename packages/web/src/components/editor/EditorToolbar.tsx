import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Edit3,
  Loader2,
  Eye,
  Bold,
  Italic,
  Link2,
  Code,
  Quote,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Table,
  X,
  ImagePlus,
  Images,
  Sparkles,
  Upload,
} from 'lucide-react'
import { Tooltip, ShortcutKeys, shortcutLabel } from '../ui'
import { useAiCapabilities } from '../../hooks/useAiCapabilities'
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss'
import type { CodeMirrorEditorHandle } from './CodeMirrorEditor'
import AssetPickerDialog from './AssetPickerDialog'

type Mode = 'edit' | 'view'

interface EditorToolbarProps {
  mode: Mode
  onModeToggle: (mode: Mode) => void
  saving: boolean
  loading: boolean
  uploadingImage: boolean
  /** 上传进度 0-100。>0 时在图片按钮上叠加进度环与百分比。 */
  uploadProgress?: number
  showHelp: boolean
  onToggleHelp: (show: boolean) => void
  onSave: () => void
  onCancel: () => void
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
  wrapSelection: (left: string, right?: string) => void
  uploadImage: (file: File) => void
  editorRef: React.RefObject<CodeMirrorEditorHandle | null>
}

export default function EditorToolbar({
  mode,
  onModeToggle,
  saving,
  loading,
  uploadingImage,
  uploadProgress = 0,
  showHelp,
  onToggleHelp,
  onSave,
  onCancel,
  insertAtCursor,
  wrapSelection,
  uploadImage,
  editorRef,
}: EditorToolbarProps) {
  const { t } = useTranslation()
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageBtnRef = useRef<HTMLButtonElement>(null)
  const imageMenuRef = useRef<HTMLDivElement>(null)
  const [imageMenuOpen, setImageMenuOpen] = useState(false)
  const [imageMenuPos, setImageMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // AI 能力探测：有 chat/embedding/reranker 任一能力时静默成功；
  // 三个都 false 时在工具栏右侧出现一个链接入口指向 settings/ai。
  const ai = useAiCapabilities()
  const aiConfigured = ai.chat || ai.embedding || ai.reranker

  const handleInsertLink = () => {
    const sel = editorRef.current?.getSelectionText() ?? ''
    const hasSel = sel.length > 0
    const linkText = hasSel ? sel : 'text'
    const ins = `[${linkText}](url)`
    if (hasSel) {
      wrapSelection('[', '](url)')
    } else {
      insertAtCursor(ins, { cursorOffset: linkText.length + 3 })
    }
  }

  const insertAssetRef = (ref: string) => {
    const alt = t('editorToolbar.imageAlt')
    insertAtCursor(`\n![${alt}](${ref})\n`)
    setPickerOpen(false)
  }

  useLayoutEffect(() => {
    if (!imageMenuOpen) {
      setImageMenuPos(null)
      return
    }
    const el = imageBtnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const menuW = 180
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8))
    setImageMenuPos({ top: r.bottom + 6, left })
  }, [imageMenuOpen])

  usePopoverDismiss(imageMenuOpen, { onClose: () => setImageMenuOpen(false) }, imageMenuRef, imageBtnRef)

  return (
    <div className="sticky top-14 z-10 -mx-4 sm:-mx-8 px-4 sm:px-8 mb-2 bg-background/85 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 py-1.5 border-b border-border/60">
        <IconBtn title={t('editorToolbar.h1')} onClick={() => insertAtCursor('\n# ')}>
          <Heading1 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.h2')} onClick={() => insertAtCursor('\n## ')}>
          <Heading2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.h3')} onClick={() => insertAtCursor('\n### ')}>
          <Heading3 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <ToolbarDivider />
        <IconBtn title={t('editorToolbar.bulletList')} onClick={() => insertAtCursor('\n- ')}>
          <List className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.orderedList')} onClick={() => insertAtCursor('\n1. ')}>
          <ListOrdered className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.quote')} onClick={() => insertAtCursor('\n> ')}>
          <Quote className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.codeBlock')} onClick={() => insertAtCursor('\n```\n\n```\n', { cursorOffset: 5 })}>
          <Code className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.insertTable')} onClick={() => editorRef.current?.insertTable()}>
          <Table className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <ToolbarDivider />
        <IconBtn title={t('editorToolbar.bold', { shortcut: shortcutLabel(['mod', 'B']) })} onClick={() => wrapSelection('**')}>
          <Bold className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.italic', { shortcut: shortcutLabel(['mod', 'I']) })} onClick={() => wrapSelection('*')}>
          <Italic className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.inlineCode', { shortcut: shortcutLabel(['mod', 'E']) })} onClick={() => wrapSelection('`')}>
          <Code className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={t('editorToolbar.link', { shortcut: shortcutLabel(['mod', '⇧K']) })} onClick={handleInsertLink}>
          <Link2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <Tooltip
          label={
            uploadingImage
              ? t('editorToolbar.uploadingProgress', { pct: uploadProgress })
              : t('editorToolbar.insertImage')
          }
        >
          <button
            ref={imageBtnRef}
            type="button"
            disabled={uploadingImage}
            aria-label={t('editorToolbar.insertImage')}
            aria-expanded={imageMenuOpen}
            aria-haspopup="menu"
            onClick={() => {
              if (uploadingImage) return
              setImageMenuOpen((v) => !v)
            }}
            className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-all active:scale-[0.92] disabled:opacity-50 ${
              imageMenuOpen
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {uploadingImage ? (
              <UploadProgressRing progress={uploadProgress} />
            ) : (
              <ImagePlus className="w-[15px] h-[15px]" strokeWidth={1.75} />
            )}
          </button>
        </Tooltip>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void uploadImage(f)
            e.target.value = ''
          }}
        />
        {imageMenuOpen && imageMenuPos && createPortal(
          <div
            ref={imageMenuRef}
            role="menu"
            aria-label={t('editorToolbar.insertImage')}
            className="fixed z-[80] min-w-[180px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in"
            style={{ top: imageMenuPos.top, left: imageMenuPos.left }}
          >
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left text-foreground hover:bg-accent transition-colors"
              onClick={() => {
                setImageMenuOpen(false)
                imageInputRef.current?.click()
              }}
            >
              <Upload className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
              <span>{t('editorToolbar.uploadLocal')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left text-foreground hover:bg-accent transition-colors"
              onClick={() => {
                setImageMenuOpen(false)
                setPickerOpen(true)
              }}
            >
              <Images className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
              <span>{t('editorToolbar.fromLibrary')}</span>
            </button>
          </div>,
          document.body,
        )}
        <AssetPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={insertAssetRef}
        />

        <div className="flex items-center gap-1 ml-auto">
          {!aiConfigured && (
            <Tooltip label={t('editorToolbar.aiNotConfiguredHint', { defaultValue: 'AI 未配置，点此去设置' })}>
              <Link
                to="/settings/ai"
                className="inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 opacity-70" strokeWidth={1.75} />
                {t('editorToolbar.aiSetup', { defaultValue: 'AI 未配置' })}
              </Link>
            </Tooltip>
          )}
          <IconBtn
            title={mode === 'view' ? t('editorToolbar.backToEdit', { shortcut: shortcutLabel(['mod', 'P']) }) : t('editorToolbar.preview', { shortcut: shortcutLabel(['mod', 'P']) })}
            onClick={() => onModeToggle(mode === 'edit' ? 'view' : 'edit')}
            active={mode === 'view'}
          >
            {mode === 'view' ? <Edit3 className="w-[15px] h-[15px]" strokeWidth={1.75} /> : <Eye className="w-[15px] h-[15px]" strokeWidth={1.75} />}
          </IconBtn>
          <IconBtn title={t('editorToolbar.shortcuts')} onClick={() => onToggleHelp(!showHelp)} active={showHelp}>
            <span className="text-[12px] font-medium leading-none">?</span>
          </IconBtn>
          <ToolbarDivider />
          <Tooltip label={saving ? t('editorToolbar.saving') : t('editorToolbar.saveAndReturn', { shortcut: shortcutLabel(['mod', 'S']) })}>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || loading}
              className={`inline-flex items-center justify-center gap-1 h-7 px-3 min-w-[64px] rounded-md text-[12px] font-medium border transition-all active:scale-[0.97] disabled:cursor-not-allowed bg-[rgb(var(--primary))] text-[rgb(var(--primary-foreground))] border-[rgb(var(--primary))] shadow-[var(--shadow-btn)] hover:bg-[rgb(var(--primary-hover))] hover:border-[rgb(var(--primary-hover))] ${saving ? 'opacity-70 cursor-wait' : 'disabled:opacity-40'}`}
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              {saving ? t('editorToolbar.savingShort') : t('editorToolbar.save')}
            </button>
          </Tooltip>
          <IconBtn title={t('editorToolbar.exitEdit')} onClick={onCancel}>
            <X className="w-[15px] h-[15px]" strokeWidth={1.75} />
          </IconBtn>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: ReactNode
  onClick: () => void
  title: string
  active?: boolean
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-all active:scale-[0.92] ${
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function ToolbarDivider() {
  return <span className="w-px h-4 bg-border/80 mx-1.5" />
}

/**
 * 小尺寸上传进度环（16×16）—— SVG 圆环 + 中心百分比文字。
 * 为紧凑：环 stroke-width=2、padding=2、字 8px。单文件上传足够看。
 */
function UploadProgressRing({ progress }: { progress: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const dash = (Math.min(99, Math.max(0, progress)) / 100) * c
  return (
    <div className="relative w-[16px] h-[16px] grid place-items-center">
      <svg viewBox="0 0 16 16" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="8" cy="8" r={r} stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" fill="none" />
        <circle
          cx="8"
          cy="8"
          r={r}
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          className="text-primary transition-[stroke-dasharray] duration-150 ease-out"
        />
      </svg>
      <span className="relative text-[8px] font-medium tabular-nums leading-none text-foreground/80">
        {Math.min(99, Math.max(0, progress))}
      </span>
    </div>
  )
}

export function ShortcutsHelp({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <ShortcutKeys keys={keys} />
      <span>{desc}</span>
    </div>
  )
}
