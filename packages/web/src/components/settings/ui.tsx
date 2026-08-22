import { useState, useEffect, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { HelpTip } from '../ui'

export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-28">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground/70 select-none">
        {title}
      </h2>
      <div className="space-y-4">
        {children}
      </div>
    </section>
  )
}

// --- Card Components ---

export function SettingsCard({
  title,
  icon,
  statusBadge,
  defaultExpanded = false,
  children,
  dangerZone,
  collapsible = true,
  helpTip,
}: {
  title: string
  icon?: ReactNode
  statusBadge?: ReactNode
  defaultExpanded?: boolean
  children: ReactNode
  dangerZone?: ReactNode
  collapsible?: boolean
  /** 标题旁的提示图标（避免为提示单独占一行） */
  helpTip?: string
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-card overflow-hidden transition-colors hover:border-border/80">
      <div 
        className={`flex items-center justify-between px-5 py-3.5 ${collapsible ? 'cursor-pointer hover:bg-accent/30' : ''}`}
        onClick={() => collapsible && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2.5">
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <h3 className="text-base font-medium text-foreground">{title}</h3>
          {helpTip && <HelpTip label={helpTip} />}
        </div>
        <div className="flex items-center gap-3">
          {statusBadge}
          {collapsible && (
            expanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground/60" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground/60" />
            )
          )}
        </div>
      </div>

      <div
        className={`grid duration-200 ease-in-out ${
          expanded || !collapsible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="p-5 border-t border-border/40 space-y-5 bg-card/50">
            {children}
          </div>
          {dangerZone && (
            <div className="px-5 py-4 bg-destructive/[0.02] border-t border-destructive/10">
              {dangerZone}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Form & Fields ---

export function InlineField({
  label,
  value,
  onChange,
  onSave,
  type = 'text',
  placeholder,
  mono = false,
  status,
  statusMessage,
  description,
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  onSave?: () => Promise<void> | void
  type?: 'text' | 'password' | 'number'
  placeholder?: string
  mono?: boolean
  status?: 'idle' | 'testing' | 'success' | 'error'
  statusMessage?: string
  description?: string
}) {
  const { t } = useTranslation()
  const [localStatus, setLocalStatus] = useState(status || 'idle')

  useEffect(() => {
    if (status) setLocalStatus(status)
  }, [status])

  const handleBlur = async () => {
    if (onSave) {
      setLocalStatus('testing')
      try {
        await onSave()
        setLocalStatus('success')
      } catch {
        setLocalStatus('error')
      }
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  return (
    <div className="group space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
          {description && (
            <span className="text-xs text-muted-foreground/60">{description}</span>
          )}
        </div>
        {localStatus === 'success' && <span className="text-xs text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {t('settingsUI.saved')}</span>}
        {localStatus === 'testing' && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {t('settingsUI.verifying')}</span>}
      </div>

      <div className="space-y-2">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full px-3 py-1.5 rounded-md border ${localStatus === 'error' ? 'border-destructive/50' : 'border-border focus:border-primary/50'} bg-background transition-colors placeholder:text-muted-foreground/40 ${mono ? 'font-mono text-base' : 'text-md'}`}
        />
        {localStatus === 'error' && statusMessage && (
          <div className="text-xs text-destructive flex items-center gap-1 mt-1">
            <AlertCircle className="w-3 h-3" />
            {statusMessage}
          </div>
        )}
      </div>
    </div>
  )
}

export function StatusBadge({ active, label, error }: { active: boolean; label?: string; error?: boolean }) {
  const { t } = useTranslation()
  if (error) {
    return <span className="text-2xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium border border-destructive/20 flex items-center gap-1"><AlertCircle className="w-3 h-3"/> {t('settingsUI.error')}</span>
  }
  return active ? (
    <span className="text-2xs px-2 py-0.5 rounded-full bg-success-soft text-success font-medium border border-success/20">
      {label || t('settingsUI.active')}
    </span>
  ) : (
    <span className="text-2xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
      {label || t('settingsUI.disabled')}
    </span>
  )
}
