import { Eye, Pencil, Save, Download } from 'lucide-react'
import ImportButton from './ImportButton'
import type { ImportPayload } from '@notefast/shared'

export type EditorMode = 'edit' | 'view'

interface EditorToolbarProps {
  mode: EditorMode
  onToggleMode: () => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  onSaveAs: () => void
  filePath: string
  /** 导入 payload（由父组件携当前内容构造） */
  importPayload: ImportPayload
  /** 是否已配置 NoteFast（ImportButton 据此禁用） */
  importReady: boolean
  onImported: (docId: string, deduplicated: boolean) => void
}

/** 编辑器顶栏：模式切换 / 保存 / 另存 / 导入到 NoteFast。撤销/重做走 CM 内置 Mod-z。 */
export default function EditorToolbar({
  mode,
  onToggleMode,
  dirty,
  saving,
  onSave,
  onSaveAs,
  filePath,
  importPayload,
  importReady,
  onImported,
}: EditorToolbarProps) {
  const btn =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-45 disabled:cursor-not-allowed'

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <div className="min-w-0 truncate text-sm text-muted-foreground">
        {filePath || '未命名.md'}
        {dirty && <span className="ml-2 text-xs">· 未保存</span>}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${btn} border border-border text-foreground hover:bg-accent`}
          onClick={onToggleMode}
          title={mode === 'edit' ? '预览 (⌘P)' : '编辑 (⌘P)'}
        >
          {mode === 'edit' ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          {mode === 'edit' ? '预览' : '编辑'}
        </button>

        <button
          type="button"
          className={`${btn} border border-border text-foreground hover:bg-accent`}
          onClick={onSave}
          disabled={saving}
        >
          <Save className="h-4 w-4" />
          {saving ? '保存中…' : '保存'}
        </button>

        <button
          type="button"
          className={`${btn} border border-border text-foreground hover:bg-accent`}
          onClick={onSaveAs}
        >
          <Download className="h-4 w-4" />
          另存为
        </button>

        <ImportButton payload={importPayload} disabled={!importReady} onImported={onImported} />
      </div>
    </div>
  )
}
