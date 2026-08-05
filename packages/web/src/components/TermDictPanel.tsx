import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookMarked, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import { SettingsCard } from './settings/ui'

interface TermDictEntry {
  name: string
  aliases: string[]
  kind?: string
}

interface TermDictPayload {
  enabled: boolean
  count: number
  alias_count: number
  terms: TermDictEntry[]
}

/**
 * 实体词典面板：用户声明的「实体校准层」（别名 → 标准名收敛）。
 * 空词典 = 检索行为零变化；编辑保存后服务端自动做存量归并。
 */
export default function TermDictPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [stats, setStats] = useState<{ enabled: boolean; count: number; aliasCount: number } | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    api
      .get<TermDictPayload>('/term-dict')
      .then((d) => {
        setStats({ enabled: d.enabled, count: d.count, aliasCount: d.alias_count })
        setText(JSON.stringify(d.terms, null, 2))
      })
      .catch(() => setStats(null))
  }, [])

  const handleSave = async () => {
    let terms: unknown
    try {
      terms = JSON.parse(text)
    } catch {
      toast.error({ title: t('settings.termDict.invalidJson') })
      return
    }
    if (!Array.isArray(terms)) {
      toast.error({ title: t('settings.termDict.invalidJson') })
      return
    }
    await toast.promise(
      async () => {
        const d = await api.put<TermDictPayload>('/term-dict', { terms })
        setStats({ enabled: d.enabled, count: d.count, aliasCount: d.alias_count })
        setText(JSON.stringify(d.terms ?? terms, null, 2))
      },
      {
        loading: t('settings.termDict.saving'),
        success: t('settings.termDict.saved'),
        error: (e) => ({ title: t('settings.termDict.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleRebuild = async () => {
    try {
      const r = await api.post<{ merged: number; created: number; kindUpdated: number }>('/term-dict/rebuild', {})
      toast.success({
        title: t('settings.termDict.rebuildDone'),
        description: t('settings.termDict.rebuildResult', {
          merged: r.merged,
          created: r.created,
          kindUpdated: r.kindUpdated,
        }),
      })
    } catch (e) {
      toast.error({ title: t('settings.termDict.rebuildFailed'), description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleClear = async () => {
    await toast.promise(
      async () => {
        const d = await api.put<TermDictPayload>('/term-dict', { terms: [] })
        setStats({ enabled: d.enabled, count: d.count, aliasCount: d.alias_count })
        setText('[]')
      },
      {
        loading: t('settings.termDict.saving'),
        success: t('settings.termDict.cleared'),
        error: (e) => ({ title: t('settings.termDict.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  return (
    <SettingsCard
      title={t('settings.termDict.title')}
      icon={<BookMarked className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('settings.termDict.helpTip')}
    >
      <div className="space-y-4">
        <p className="text-[12.5px] text-muted-foreground">{t('settings.termDict.description')}</p>

        {stats && (
          <div className="flex items-center gap-2 text-[12px]">
            {stats.enabled ? (
              <span className="px-2 py-1 rounded-md bg-primary-soft text-primary font-medium">
                {t('settings.termDict.enabled', { count: stats.count, aliases: stats.aliasCount })}
              </span>
            ) : (
              <span className="px-2 py-1 rounded-md bg-muted text-muted-foreground">
                {t('settings.termDict.disabled')}
              </span>
            )}
          </div>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={t('settings.termDict.editorPlaceholder')}
          className="w-full rounded-lg border border-border/60 bg-background p-3 font-mono text-[12px] text-foreground leading-relaxed focus:outline-none focus:border-foreground/40 focus:ring-1 focus:ring-foreground/20"
        />

        <div className="flex items-center gap-3">
          <ActionButton onAction={handleSave}>{t('settings.termDict.save')}</ActionButton>
          <ActionButton variant="secondary" onAction={handleRebuild}>
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
            {t('settings.termDict.rebuild')}
          </ActionButton>
          {stats?.enabled && (
            <ActionButton variant="secondary" onAction={handleClear}>
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              {t('settings.termDict.clear')}
            </ActionButton>
          )}
        </div>
      </div>
    </SettingsCard>
  )
}
