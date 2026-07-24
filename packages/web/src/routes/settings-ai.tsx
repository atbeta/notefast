import { useState, useEffect } from 'react'
import AISettingsPanel from '../components/ai-settings'
import SettingsSubHeader from '../components/SettingsSubHeader'
import { api } from '../hooks/useAPI'

export default function SettingsAIPage() {
  const [aiConfigured, setAiConfigured] = useState(true)

  useEffect(() => {
    api.get<{ ai_configured: boolean }>('/status').then((r) => {
      setAiConfigured(Boolean(r.ai_configured))
    }).catch(() => {})
  }, [])

  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-8 animate-fade-in">
      <header className="space-y-3">
        <SettingsSubHeader section="AI" />
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">AI 配置</h1>
          <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5">
            所有 AI 能力都是可选的：没配 Chat 就不会有聊天窗口，
            没配 Embedding 就只走 FTS5。每个能力独立开关、独立降级。
          </p>
        </div>
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
