import { Link } from 'react-router-dom'

/** 默认路由：空白提示 + 「打开文件」入口（M2 接线壳层 FileService）。 */
export default function OpenView() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">NoteFastEditor</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        极简 Markdown 阅读与编辑。M1 骨架：打开文件、编辑器与设置将在后续里程碑接入。
      </p>
      <div className="flex gap-3">
        <button className="rounded-md bg-ink px-4 py-2 text-sm text-ink-foreground" disabled>
          打开文件…
        </button>
        <Link
          to="/settings"
          className="rounded-md border border-border px-4 py-2 text-sm text-foreground"
        >
          设置
        </Link>
      </div>
    </main>
  )
}
