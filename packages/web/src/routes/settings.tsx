import SyncPanel from '../components/SyncPanel'

export default function SettingsPage() {
  return (
    <div className="space-y-6 py-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-sm text-muted-foreground">
          配置 NoteFast 的可选项。NoteFast 优先本地优先 & 可选 AI / 可选同步，所有能力都可关闭。
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">数据主权</h2>
        <SyncPanel />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">AI 能力</h2>
        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          AI 相关配置（Embedding / Chat / Reranker / AutoLink）请访问{' '}
          <a href="/settings/ai" className="text-primary hover:underline">
            /settings/ai
          </a>
          ，或在使用 Chat / 搜索面板时通过链接前往。
        </div>
      </section>
    </div>
  )
}
