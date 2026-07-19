import { ArrowRight } from 'lucide-react'
import SyncPanel from '../components/SyncPanel'

export default function SettingsPage() {
  return (
    <div className="w-full max-w-3xl mx-auto px-8 py-10 space-y-10 animate-fade-in">
      <header className="space-y-1.5">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">设置</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          配置 NoteFast 的可选项。本地优先，AI 与同步皆为可选能力，均可关闭。
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="px-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80 select-none">
          数据主权
        </h2>
        <SyncPanel />
      </section>

      <section className="space-y-3">
        <h2 className="px-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80 select-none">
          AI 能力
        </h2>
        <a
          href="/settings/ai"
          className="group block rounded-xl border border-border bg-card px-5 py-4 hover:border-foreground/20 transition-colors"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13.5px] font-medium text-foreground">配置 AI Provider、Embedding、Reranker、AutoLink</div>
              <p className="text-[12px] text-muted-foreground mt-1">所有 AI 能力都可以在这里独立开关</p>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground/60 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" strokeWidth={1.75} />
          </div>
        </a>
      </section>
    </div>
  )
}
