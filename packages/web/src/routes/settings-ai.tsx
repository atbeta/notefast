import { useState, useEffect } from 'react'
import AISettingsPanel from '../components/ai-settings'
import { api } from '../hooks/useAPI'

export default function SettingsAIPage() {
  const [aiConfigured, setAiConfigured] = useState(true)

  useEffect(() => {
    api.get<{ ai_configured: boolean }>('/status').then((r) => {
      if ((r as any).body) setAiConfigured((r as any).body.ai_configured)
    }).catch(() => {})
  }, [])

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

      {!aiConfigured && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-5 py-3.5">
          <p className="text-[13px] text-amber-700 dark:text-amber-400 leading-relaxed">
            AI 尚未配置 — Chat、语义搜索、AutoLink 等功能当前不可用。
            请在下方填写 API Key 与模型信息以启用。
          </p>
        </div>
      )}

      <AISettingsPanel />
    </div>
  )
}
