import { useState, useEffect, useCallback } from 'react'
import { Shield, Monitor, Phone, Globe } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { SettingsCard } from './settings/ui'

interface AuthEvent {
  id: string
  event_type: string
  ip: string | null
  user_agent: string | null
  created_at: string
}

function guessDevice(ua: string | null): { label: string; icon: typeof Monitor } {
  if (!ua) return { label: '未知设备', icon: Monitor }
  const lower = ua.toLowerCase()
  if (lower.includes('mobile') || lower.includes('android') || lower.includes('iphone'))
    return { label: '手机', icon: Phone }
  if (lower.includes('ipad') || lower.includes('tablet'))
    return { label: '平板', icon: Phone }
  return { label: '桌面', icon: Monitor }
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
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHr < 24) return `${diffHr} 小时前`
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = d.getHours().toString().padStart(2, '0')
  const minute = d.getMinutes().toString().padStart(2, '0')
  return `${month}月${day}日 ${hour}:${minute}`
}

export default function AuthEventsPanel() {
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
      title="登录活动"
      icon={<Shield className="w-4 h-4" strokeWidth={1.75} />}
      collapsible
    >
      <p className="text-[12px] text-muted-foreground">加载中...</p>
    </SettingsCard>
  )

  return (
    <SettingsCard
      title="登录活动"
      icon={<Shield className="w-4 h-4" strokeWidth={1.75} />}
      collapsible
    >
      <p className="text-[12.5px] text-muted-foreground leading-relaxed">
        最近 30 次登录记录。如果发现陌生的 IP 或设备，请立即修改密码。
      </p>

      {events.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">暂无登录记录。新登录后会出现在这里。</p>
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
                <div className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${isLatest ? 'bg-emerald-500/10 text-emerald-600' : 'bg-accent text-muted-foreground'}`}>
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
                      <span className="px-1.5 py-0.5 rounded text-[9.5px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20">
                        最近
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
