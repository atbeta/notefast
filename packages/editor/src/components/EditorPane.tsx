import { forwardRef } from 'react'
import { CodeMirrorEditor } from '@notefast/shared'
import type { CodeMirrorEditorHandle } from '@notefast/shared'

interface EditorPaneProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onToggleMode: () => void
  placeholder?: string
}

/**
 * 编辑器窗格：包一层 shared 的 CodeMirrorEditor，屏蔽 NoteFastEditor 尚不启用的
 * AI ghost / AI 续写 / 图片上传能力（M2 无 AI provider 与资源库，传空实现）。
 */
const EditorPane = forwardRef<CodeMirrorEditorHandle, EditorPaneProps>(function EditorPane(
  { value, onChange, onSave, onToggleMode, placeholder },
  ref,
) {
  return (
    <div className="min-w-0 flex-1">
      <CodeMirrorEditor
        ref={ref}
        value={value}
        onChange={onChange}
        onSave={onSave}
        onToggleMode={onToggleMode}
        onAiContinue={() => {}}
        onCancel={() => {}}
        onImageFile={() => {}}
        ghostText=""
        onGhostAccept={() => {}}
        onGhostDismiss={() => {}}
        placeholder={placeholder}
      />
    </div>
  )
})

export default EditorPane
