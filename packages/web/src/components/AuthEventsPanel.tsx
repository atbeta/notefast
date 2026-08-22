import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import { Shield, Monitor, Phone, Globe } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { HelpTip } from './ui'
import { SettingsCard } from './settings/ui'

interface AuthEvent {
  id: string
  event_type: string
  ip: string | null
  user_agent: string | null
  created_at: string
}

function guessDevice(ua: string | null): { label: string; icon: typeof Monitor } {
  if (!ua) return { label: i18next.t('authEvents.deviceUnknown'), icon: Monitor }
  const lower = ua.toLowerCase()
  if (lower.includes('mobile') || lower.includes('android') || lower.includes('iphone'))
    return { label: i18next.t('authEvents.devicePhone'), icon: Phone }
  if (lower.includes('ipad') || lower.includes('tablet'))
    return { label: i18next.t('authEvents.deviceTablet'), icon: Phone }
  return { label: i18next.t('authEvents.deviceDesktop'), icon: Monitor }
}

// 顺序敏感：Edge UA 含 'Chrome'，Chrome UA 含 'Safari'
function guessBrowser(ua: string | null): string {
  if (!ua) return ''
  const lower = ua.toLowerCase()
  if (lower.includes('firefox')) return 'Firefox'
  if (lower.includes('edg')) return 'Edge'
  if (lower.includes('chrome')) return 'Chrome'
  if (lower.includes('safari')) return 'Safari'
  return ''
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  if (diffMin < 1) return i18next.t('time.justNow')
  if (diffMin < 60) return i18next.t('time.minutesAgo', { n: diffMin })
  if (diffHr < 24) return i18next.t('time.hoursAgo', { n: diffHr })
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = d.getHours().toString().padStart(2, '0')
  const minute = d.getMinutes().toString().padStart(2, '0')
  return i18next.t('authEvents.dateTime', { month, day, hour, minute })
}

export default function AuthEventsPanel() {
  const { t } = useTranslation()
  const [events, setEvents] = useState<AuthEvent[]>([])
  const [loading, setLoading] = useState(true)

  const loadEvents = useCallback(async () => {
    try {
      const data = await api.get<AuthEvent[]>('/auth/events')
      if (Array.isArray(data)) setEvents(data)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadEvents()
    const onFocus = () => loadEvents()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadEvents])

  if (loading) return (
    <SettingsCard
      title={t('authEvents.title')}
      icon={<Shield className="w-4 h-4" strokeWidth={1.75} />}
      collapsible
    >
      <p className="text-[12px] text-muted-foreground">{t('common.loading')}</p>
    </SettingsCard>
  )

  return (
    <SettingsCard
      title={t('authEvents.title')}
      icon={<Shield className="w-4 h-4" strokeWidth={1.75} />}
      collapsible
    >
      <div className="flex items-center gap-1.5">
        <p className="text-[12.5px] text-muted-foreground leading-relaxed">{t('authEvents.recentCount')}</p>
        <HelpTip label={t('authEvents.helpTip')} />
      </div>

      {events.length === 0 ? (
        <div className="space-y-1">
          <p className="text-[12px] text-muted-foreground">{t('authEvents.empty')}</p>
          <p className="text-[11.5px] text-muted-foreground/70 leading-relaxed">{t('authEvents.emptyHint')}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          {events.map((ev, i) => {
            const device = guessDevice(ev.user_agent)
            const browser = guessBrowser(ev.user_agent)
            const isLatest = i === 0
            return (
              <div
                key={ev.id}
                className={`flex items-center gap-3 px-4 py-3 ${i !== events.length - 1 ? 'border-b border-border/50' : ''} bg-background`}
              >
                <div className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${isLatest ? 'bg-success-soft text-success' : 'bg-accent text-muted-foreground'}`}>
                  {!ev.ip ? (
                    <Monitor className="w-4 h-4" strokeWidth={1.75} />
                  ) : (
                    <Globe className="w-4 h-4" strokeWidth={1.75} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">{device.label}</span>
                    {browser && <span className="text-[11px] text-muted-foreground">{browser}</span>}
                    {isLatest && (
                      <span className="px-1.5 py-0.5 rounded text-[9.5px] font-medium bg-success-soft text-success border border-success/20">
                        {t('authEvents.latest')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                    {ev.ip && (
                      <span className="font-mono">{ev.ip}</span>
                    )}
                    <span>{formatTime(ev.created_at)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </SettingsCard>
  )
}
