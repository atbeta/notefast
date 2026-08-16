import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import EditorPane from '../components/EditorPane'
import PreviewPane from '../components/PreviewPane'
import EditorToolbar, { type EditorMode } from '../components/EditorToolbar'
import { newFile, saveFile, saveFileAs, type OpenFile } from '../lib/fileSystem'
import { loadSettings } from '../lib/settings'
import type { CodeMirrorEditorHandle, ImportPayload } from '@notefast/shared'

const DEMO_MD = `# 欢迎使用 NoteFastEditor

这是一个 **Markdown** 编辑器。左侧编辑、右侧预览，或点击顶栏「预览」切换模式。

## 功能

- 编辑：基于 CodeMirror 6 的混合渲染
- 预览：GFM + 代码高亮 + Mermaid + KaTeX
- 保存 / 另存为：直接读写本地 \`.md\`
- 导入到 NoteFast：把当前内容推送到你的知识库

\`\`\`js
console.log('hello, notefast')
\`\`\`

> 试试选中一段文字，或输入 \`\`\` 展开代码块。
`

/** 从文件名提取标题（首个 H1 或文件名去扩展） */
function titleOf(file: OpenFile): string {
  const m = /^#\s+(.+)$/m.exec(file.content)
  return m ? m[1].trim() : file.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')
}

export default function EditorView() {
  const [file, setFile] = useState<OpenFile>(() => newFile())
  const [mode, setMode] = useState<EditorMode>('edit')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const editorRef = useRef<CodeMirrorEditorHandle>(null)

  // 未配置 NoteFast 时导入按钮禁用
  const [importReady, setImportReady] = useState(false)
  useEffect(() => {
    setImportReady(Boolean(loadSettings().noteFastUrl))
  }, [])

  useEffect(() => {
    // 打开流程传入的文件优先；否则无路径时加载 demo 内容，便于浏览器 mock 验证
    const raw = sessionStorage.getItem('notefast.editor.openFile')
    if (raw) {
      try {
        const opened = JSON.parse(raw) as { path?: string; name?: string; content?: string }
        if (opened?.content != null) {
          setFile({
            path: opened.path ?? '',
            name: opened.name ?? opened.path ?? '未命名.md',
            content: opened.content,
            dirty: false,
          })
        }
      } finally {
        sessionStorage.removeItem('notefast.editor.openFile')
      }
    }
    setFile((f) => (f.content === '' && f.path === '' ? { ...f, content: DEMO_MD } : f))
  }, [])

  const onChange = useCallback((content: string) => {
    setFile((f) => ({ ...f, content, dirty: true }))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setNotice('')
    try {
      const result = await saveFile(file.path, file.content)
      if (result) {
        setFile((f) => ({ ...f, name: result, dirty: false }))
      } else if (file.path) {
        setFile((f) => ({ ...f, dirty: false }))
      }
      setNotice('已保存')
      setTimeout(() => setNotice(''), 1500)
    } catch {
      setNotice('保存失败')
    } finally {
      setSaving(false)
    }
  }, [file])

  const handleSaveAs = useCallback(async () => {
    setNotice('')
    try {
      const result = await saveFileAs(file.content)
      if (result) {
        setFile((f) => ({ ...f, path: result, name: result, dirty: false }))
      }
    } catch {
      setNotice('另存为失败')
    }
  }, [file.content])

  const handleToggleMode = useCallback(() => {
    setMode((m) => (m === 'edit' ? 'view' : 'edit'))
  }, [])

  const handleImported = useCallback(() => {
    setNotice('已导入到 NoteFast')
    setTimeout(() => setNotice(''), 1500)
  }, [])

  const importPayload: ImportPayload = useMemo(
    () => ({
      markdown: file.content,
      title: titleOf(file),
      source: {
        provider: 'note-fast-editor',
        external_id: file.path || `untitled:${file.name}`,
      },
    }),
    [file],
  )

  return (
    <div className="flex h-screen flex-col">
      <EditorToolbar
        mode={mode}
        onToggleMode={handleToggleMode}
        dirty={file.dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        filePath={file.path || file.name}
        importPayload={importPayload}
        importReady={importReady}
        onImported={handleImported}
      />

      {notice && (
        <div className="border-b border-border bg-muted/40 px-4 py-1 text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {mode === 'edit' ? (
          <>
            <EditorPane
              ref={editorRef}
              value={file.content}
              onChange={onChange}
              onSave={handleSave}
              onToggleMode={handleToggleMode}
              placeholder="# 开始写…"
            />
            <div className="hidden w-1/2 border-l border-border md:block">
              <div className="h-full overflow-y-auto px-6 py-4">
                <PreviewPane content={file.content} />
              </div>
            </div>
          </>
        ) : (
          <div className="h-full flex-1 overflow-y-auto px-6 py-4">
            <PreviewPane content={file.content} />
          </div>
        )}
      </div>
    </div>
  )
}
