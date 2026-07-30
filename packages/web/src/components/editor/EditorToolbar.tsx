import { useRef, type ReactNode } from 'react'
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
} from 'lucide-react'
import { Tooltip, ShortcutKeys, shortcutLabel } from '../ui'

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
  content: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
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
  content,
  textareaRef,
}: EditorToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null)

  const handleInsertLink = () => {
    const sel = content.slice(textareaRef.current?.selectionStart ?? 0, textareaRef.current?.selectionEnd ?? 0)
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
    <div className="sticky top-14 z-10 -mx-8 px-8 mb-2 bg-background/85 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 py-1.5 border-b border-border/60">
        <IconBtn title="一级标题 (#)" onClick={() => insertAtCursor('\n# ')}>
          <Heading1 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title="二级标题 (##)" onClick={() => insertAtCursor('\n## ')}>
          <Heading2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title="三级标题 (###)" onClick={() => insertAtCursor('\n### ')}>
          <Heading3 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <ToolbarDivider />
        <IconBtn title="无序列表 (-)" onClick={() => insertAtCursor('\n- ')}>
          <List className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title="有序列表 (1.)" onClick={() => insertAtCursor('\n1. ')}>
          <ListOrdered className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title="引用 (>)" onClick={() => insertAtCursor('\n> ')}>
          <Quote className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title="代码块 (```)" onClick={() => insertAtCursor('\n```\n\n```\n', { cursorOffset: 5 })}>
          <Code className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <ToolbarDivider />
        <IconBtn title={`加粗 (${shortcutLabel(['mod', 'B'])})`} onClick={() => wrapSelection('**')}>
          <Bold className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={`斜体 (${shortcutLabel(['mod', 'I'])})`} onClick={() => wrapSelection('*')}>
          <Italic className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={`行内代码 (${shortcutLabel(['mod', 'E'])})`} onClick={() => wrapSelection('`')}>
          <Code className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn title={`链接 (${shortcutLabel(['mod', '⇧K'])})`} onClick={handleInsertLink}>
          <Link2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
        </IconBtn>
        <IconBtn
          title={uploadingImage ? '上传中…' : '插入图片（也可直接粘贴/拖入）'}
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
          <IconBtn
            title={mode === 'view' ? `返回编辑 (${shortcutLabel(['mod', 'P'])})` : `预览 (${shortcutLabel(['mod', 'P'])})`}
            onClick={() => onModeToggle(mode === 'edit' ? 'view' : 'edit')}
            active={mode === 'view'}
          >
            {mode === 'view' ? <Edit3 className="w-[15px] h-[15px]" strokeWidth={1.75} /> : <Eye className="w-[15px] h-[15px]" strokeWidth={1.75} />}
          </IconBtn>
          <IconBtn title="快捷键" onClick={() => onToggleHelp(!showHelp)} active={showHelp}>
            <span className="text-[12px] font-medium leading-none">?</span>
          </IconBtn>
          <ToolbarDivider />
          <Tooltip label={saving ? '保存中…' : `保存并返回阅读 (${shortcutLabel(['mod', 'S'])})`}>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || loading}
              className={`inline-flex items-center justify-center gap-1 h-7 px-3 min-w-[64px] rounded-md text-[12px] font-medium border transition-all active:scale-[0.97] disabled:cursor-not-allowed bg-[rgb(var(--primary))] text-[rgb(var(--primary-foreground))] border-[rgb(var(--primary))] shadow-[var(--shadow-btn)] hover:bg-[rgb(var(--primary-hover))] hover:border-[rgb(var(--primary-hover))] ${saving ? 'opacity-70 cursor-wait' : 'disabled:opacity-40'}`}
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              {saving ? '保存中' : '保存'}
            </button>
          </Tooltip>
          <IconBtn title="退出编辑 (Esc)" onClick={onCancel}>
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
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
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
