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
        <a
          href="/settings/ai"
          className="block rounded-xl border border-border bg-card p-5 hover:bg-accent transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">配置 AI Provider、Embedding、Reranker、AutoLink</div>
              <p className="text-xs text-muted-foreground mt-1">所有 AI 能力都可以在这里独立开关</p>
            </div>
            <span className="text-primary text-sm">→</span>
          </div>
        </a>
      </section>
    </div>
  )
}
