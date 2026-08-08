import { useRef, type ReactNode } from 'react'
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
  X,
  ImagePlus,
  Sparkles,
} from 'lucide-react'
import { Tooltip, ShortcutKeys, shortcutLabel } from '../ui'
import { useAiCapabilities } from '../../hooks/useAiCapabilities'
import type { CodeMirrorEditorHandle } from './CodeMirrorEditor'

type Mode = 'edit' | 'view'

interface EditorToolbarProps {
  mode: Mode
  onModeToggle: (mode: Mode) => void
  saving: boolean
  loading: boolean
  uploadingImage: boolean
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
        <IconBtn
          title={uploadingImage ? t('editorToolbar.uploading') : t('editorToolbar.insertImage')}
          onClick={() => imageInputRef.current?.click()}
        >
          {uploadingImage ? (
            <Loader2 className="w-[15px] h-[15px] animate-spin" strokeWidth={1.75} />
          ) : (
            <ImagePlus className="w-[15px] h-[15px]" strokeWidth={1.75} />
          )}
        </IconBtn>
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

export function ShortcutsHelp({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <ShortcutKeys keys={keys} />
      <span>{desc}</span>
    </div>
  )
}
