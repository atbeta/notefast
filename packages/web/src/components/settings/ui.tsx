import { useState, useEffect, ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { HelpTip } from '../ui'

// --- Settings Layout & Navigation ---

interface TabInfo {
  id: string
  label: string
}

export function SettingsLayout({
  title,
  description,
  tabs,
  children,
}: {
  title: string
  description: string
  tabs: TabInfo[]
  children: ReactNode
}) {
  const [activeTab, setActiveTab] = useState(tabs[0]?.id)
  
  // Intersection Observer for active tab tracking
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Find the most visible section
        const visibleEntries = entries.filter((e) => e.isIntersecting)
        if (visibleEntries.length > 0) {
          // Sort by intersection ratio or just pick the first
          visibleEntries.sort((a, b) => b.intersectionRatio - a.intersectionRatio)
          setActiveTab(visibleEntries[0].target.id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0.1 }
    )

    tabs.forEach((tab) => {
      const el = document.getElementById(tab.id)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [tabs])

  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveTab(id)
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 py-10 space-y-8 animate-fade-in pb-32">
      <header className="space-y-3">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">{title}</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">{description}</p>
      </header>

      {/* Sticky Capsule Tabs */}
      <div className="sticky top-14 z-20 py-3 -mx-2 px-2 bg-background/80 backdrop-blur-md border-b border-border/50">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mask-edges">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => scrollTo(tab.id)}
              className={`whitespace-nowrap px-3 py-1.5 text-[13px] font-medium rounded-full transition-colors ${
                activeTab === tab.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-12">
        {children}
      </div>
    </div>
  )
}

export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-28">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70 select-none">
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
    <div className="rounded-lg border border-border/60 bg-card shadow-[var(--shadow-card)] overflow-hidden transition-colors hover:border-border/80">
      <div 
        className={`flex items-center justify-between px-5 py-3.5 ${collapsible ? 'cursor-pointer hover:bg-accent/30' : ''}`}
        onClick={() => collapsible && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2.5">
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <h3 className="text-[13.5px] font-medium text-foreground">{title}</h3>
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
          <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
          {description && (
            <span className="text-[11px] text-muted-foreground/60">{description}</span>
          )}
        </div>
        {localStatus === 'success' && <span className="text-[11px] text-emerald-500 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>}
        {localStatus === 'testing' && <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Verifying...</span>}
      </div>

      <div className="space-y-2">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full px-3 py-1.5 rounded-md border ${localStatus === 'error' ? 'border-destructive/50 ring-1 ring-destructive/30' : 'border-border focus:ring-1 focus:ring-primary/30 focus:border-primary/50'} bg-background outline-none transition-all placeholder:text-muted-foreground/40 ${mono ? 'font-mono text-[13px]' : 'text-[14px]'}`}
        />
        {localStatus === 'error' && statusMessage && (
          <div className="text-[11px] text-destructive flex items-center gap-1 mt-1">
            <AlertCircle className="w-3 h-3" />
            {statusMessage}
          </div>
        )}
      </div>
    </div>
  )
}

export function StatusBadge({ active, label, error }: { active: boolean; label?: string; error?: boolean }) {
  if (error) {
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium border border-destructive/20 flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Error</span>
  }
  return active ? (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 font-medium border border-emerald-500/20">
      {label || 'Active'}
    </span>
  ) : (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
      {label || 'Disabled'}
    </span>
  )
}
