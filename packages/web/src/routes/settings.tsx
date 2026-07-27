import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor, Database, Settings as SettingsIcon, Sparkles, Key } from 'lucide-react'
import SummaryCard from '../components/SummaryCard'
import { useTheme } from '../hooks/useTheme'
import { api } from '../hooks/useAPI'

export default function SettingsPage() {
  const [backupEnabled, setBackupEnabled] = useState<boolean | null>(null)
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null)
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    api.get<{ configured: boolean }>('/backup/config').then((r) => setBackupEnabled(r.configured)).catch(() => setBackupEnabled(false))
    api.get<{ configured: boolean }>('/sync/config').then((r) => setSyncEnabled(r.configured)).catch(() => setSyncEnabled(false))
    api.get<{ ai_configured: boolean }>('/status').then((r) => setAiEnabled(Boolean(r.ai_configured))).catch(() => setAiEnabled(false))
  }, [])

  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-10 animate-fade-in">
      <header className="space-y-1.5">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">设置</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          配置 NoteFast 的可选项。本地优先；数据库备份、Markdown 归档与 AI 均为可选能力。
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
        <div className="space-y-2.5">
          <SummaryCard
            icon={<Key className="w-4 h-4" strokeWidth={1.75} />}
            title="API Token"
            description="为外部工具、MCP 客户端或脚本创建独立 Token，支持读写权限拆分与独立撤销。"
            to="/settings/tokens"
          />
          <SummaryCard
            icon={<Database className="w-4 h-4" strokeWidth={1.75} />}
            title="数据库备份 (SQLite → S3)"
            badge={<StatusBadge enabled={backupEnabled} activeLabel="已启用" />}
            description="完整灾备：在线生成一致 SQLite 快照并上传 S3。默认每小时一次、保留 30 天。"
            to="/settings/backup"
          />
          <SummaryCard
            icon={<SettingsIcon className="w-4 h-4" strokeWidth={1.75} />}
            title="Markdown 归档（单向）"
            badge={<StatusBadge enabled={syncEnabled} activeLabel="运行中" />}
            description="将文档导出为 Markdown 推送到单一远端（LocalFS / S3 / WebDAV）。内容归档，不是完整数据库备份。"
            to="/settings/sync"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="px-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80 select-none">
          AI 能力
        </h2>
        <SummaryCard
          icon={<Sparkles className="w-4 h-4" strokeWidth={1.75} />}
          title="配置 AI Provider、Embedding、Reranker、AutoLink"
          badge={<StatusBadge enabled={aiEnabled} activeLabel="已启用" />}
          description="所有 AI 能力都可以在这里独立开关；缺哪个就降级到 FTS5 与手动链接。"
          to="/settings/ai"
        />
      </section>
    </div>
  )
}

function StatusBadge({ enabled, activeLabel }: { enabled: boolean | null; activeLabel: string }) {
  if (enabled === null) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/70 animate-pulse">
        检测中
      </span>
    )
  }
  if (enabled) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-300 font-medium">
        {activeLabel}
      </span>
    )
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">未启用</span>
  )
}

function ThemePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)] p-5 space-y-4">
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
