import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { SettingsLayout, SettingsSection } from '../components/settings/ui'

// Import the panels
import AISettingsPanel from '../components/ai-settings/AISettingsPanel'
import BackupPanel from '../components/BackupPanel'
import SyncPanel from '../components/SyncPanel'
import ApiTokensPanel from '../components/ApiTokensPanel'

export default function SettingsPage() {
  const tabs = [
    { id: 'general', label: '通用与外观' },
    { id: 'ai', label: 'AI 能力与模型' },
    { id: 'backup', label: '灾备与归档' },
    { id: 'tokens', label: 'API Tokens' },
  ]

  return (
    <SettingsLayout
      title="设置"
      description="配置 NoteFast 的可选项。本地优先；数据库备份、Markdown 归档与 AI 均为可选能力。"
      tabs={tabs}
    >
      <SettingsSection id="general" title="通用与外观">
        <ThemePicker />
      </SettingsSection>

      <SettingsSection id="ai" title="AI 能力与模型">
        <AISettingsPanel />
      </SettingsSection>

      <SettingsSection id="backup" title="灾备与归档">
        <BackupPanel />
        <SyncPanel />
      </SettingsSection>

      <SettingsSection id="tokens" title="API Tokens">
        <ApiTokensPanel />
      </SettingsSection>
    </SettingsLayout>
  )
}

function ThemePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-[var(--shadow-card)] p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-medium text-foreground">主题风格</div>
          <p className="text-[12px] text-muted-foreground mt-1">
            当前生效：
            <span className="text-foreground">{resolvedTheme === 'dark' ? '深色' : '浅色'}</span>
            {theme === 'system' && (
              <span className="ml-1.5 text-muted-foreground/80">（跟随系统）</span>
            )}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
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
          : 'border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-foreground/20'
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
