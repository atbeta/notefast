import AISettingsPanel from '../components/AISettingsPanel'

export default function SettingsAIPage() {
  return (
    <div className="space-y-6 py-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <a href="/settings" className="hover:text-foreground">设置</a>
          <span>/</span>
          <span>AI</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">AI 配置</h1>
        <p className="text-sm text-muted-foreground">
          所有 AI 能力都是 <span className="font-medium text-foreground">可选</span> 的：没配 Chat 就不会有聊天窗口，
          没配 Embedding 就只走 FTS5。每个能力独立开关、独立降级。
        </p>
      </header>

      <AISettingsPanel />
    </div>
  )
}
