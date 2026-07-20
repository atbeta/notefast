import { ArrowRight, Sun, Moon, Monitor } from 'lucide-react'
import SyncPanel from '../components/SyncPanel'
import { useTheme } from '../hooks/useTheme'

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
          外观
        </h2>
        <ThemePicker />
      </section>

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

function ThemePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-medium text-foreground">主题</div>
          <p className="text-[12px] text-muted-foreground mt-1">
            当前生效：
            <span className="text-foreground">{resolvedTheme === 'dark' ? '深色' : '浅色'}</span>
            {theme === 'system' && (
              <span className="ml-1.5 text-muted-foreground/80">（跟随系统）</span>
            )}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <ThemeOption
          active={theme === 'light'}
          onClick={() => setTheme('light')}
          icon={<Sun className="w-4 h-4" strokeWidth={1.75} />}
          label="浅色"
          hint="始终亮色"
        />
        <ThemeOption
          active={theme === 'dark'}
          onClick={() => setTheme('dark')}
          icon={<Moon className="w-4 h-4" strokeWidth={1.75} />}
          label="深色"
          hint="始终暗色"
        />
        <ThemeOption
          active={theme === 'system'}
          onClick={() => setTheme('system')}
          icon={<Monitor className="w-4 h-4" strokeWidth={1.75} />}
          label="跟随系统"
          hint="随 OS 自动切换"
        />
      </div>
    </div>
  )
}

function ThemeOption({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col items-start gap-1.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${
        active
          ? 'border-foreground/30 bg-foreground/[0.04] text-foreground'
          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/20'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[12.5px] font-medium">{label}</span>
      </div>
      <span className="text-[10.5px] text-muted-foreground/80 leading-tight">{hint}</span>
    </button>
  )
}
