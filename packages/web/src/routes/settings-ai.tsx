import AISettingsPanel from '../components/AISettingsPanel'

export default function SettingsAIPage() {
  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-8 animate-fade-in">
      <header className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80">
          <a href="/settings" className="hover:text-foreground transition-colors">设置</a>
          <span>/</span>
          <span className="text-muted-foreground">AI</span>
        </div>
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">AI 配置</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          所有 AI 能力都是可选的：没配 Chat 就不会有聊天窗口，
          没配 Embedding 就只走 FTS5。每个能力独立开关、独立降级。
        </p>
      </header>

      <AISettingsPanel />
    </div>
  )
}
