import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { requestOpenFile } from '../lib/fileSystem'

/** 默认路由：空白提示 + 「打开文件」入口。打开成功后跳转编辑器。 */
export default function OpenView() {
  const navigate = useNavigate()
  const [error, setError] = useState('')

  const handleOpen = async () => {
    setError('')
    try {
      const opened = await requestOpenFile()
      if (!opened) return // 原生壳异步回来，或用户取消
      // 通过 sessionStorage 传递给编辑器（HashRouter 下 query 传递不便）
      sessionStorage.setItem('notefast.editor.openFile', JSON.stringify(opened))
      navigate('/editor')
    } catch (e) {
      setError(e instanceof Error ? e.message : '打开文件失败')
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">NoteFastEditor</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        极简 Markdown 阅读与编辑。打开一个本地 .md 文件，或直接新建空白文档开始写作。
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          className="rounded-md bg-ink px-4 py-2 text-sm text-ink-foreground hover:bg-ink-hover"
          onClick={handleOpen}
        >
          打开文件…
        </button>
        <Link
          to="/editor"
          className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
        >
          新建空白文档
        </Link>
        <Link
          to="/settings"
          className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
        >
          设置
        </Link>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </main>
  )
}
