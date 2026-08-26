import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, HardDrive } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { getShell, isTauriShell } from '../hooks/useShell'
import { isNativeShell } from '../lib/nativeShell'
import { nativeRevealDataDir } from '../lib/nativeReveal'
import { Button, CopyButton, Toggle, useToast } from './ui'
import { SettingsCard, StatusBadge } from './settings/ui'

interface InstanceInfo {
  data_dir: string
  markdown_dir: string
  shadow_markdown_enabled: boolean
}

function revealLabelKey(): 'revealFinder' | 'revealExplorer' | 'revealFolder' {
  const shell = getShell()
  if (shell === 'macos') return 'revealFinder'
  if (isTauriShell(shell) || shell === 'windows') return 'revealExplorer'
  return 'revealFolder'
}

export default function LocalDataPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<InstanceInfo>('/instance'),
    [],
  )
  const native = isNativeShell()
  const [overrideEnabled, setOverrideEnabled] = useState<boolean | null>(null)
  const enabled = overrideEnabled ?? data?.shadow_markdown_enabled ?? true

  useEffect(() => {
    setOverrideEnabled(null)
  }, [data?.shadow_markdown_enabled])

  const handleToggle = async (next: boolean) => {
    setOverrideEnabled(next)
    try {
      await api.put('/instance', { shadow_markdown_enabled: next })
      refetch()
    } catch (e) {
      setOverrideEnabled(null)
      toast.error({
        title: t('settings.localData.saveFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return (
    <SettingsCard
      title={t('settings.localData.title')}
      icon={<HardDrive className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('settings.localData.helpTip')}
      defaultExpanded
      statusBadge={
        <StatusBadge
          active={enabled}
          label={enabled ? t('settings.localData.shadowOn') : t('settings.localData.shadowOff')}
        />
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="text-base font-medium text-foreground">{t('settings.localData.pathLabel')}</div>
          {loading && !data ? (
            <p className="text-sm text-muted-foreground">{t('settings.about.versionLoading')}</p>
          ) : error ? (
            <p className="text-sm text-destructive">{t('settings.localData.loadFailed')}</p>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 text-sm break-all rounded-md border border-border bg-background px-3 py-2 text-foreground">
                  {data?.data_dir}
                </code>
                {data?.data_dir && (
                  <CopyButton
                    text={data.data_dir}
                    ariaLabel={t('settings.localData.copyPath')}
                    title={t('settings.localData.copyPath')}
                    className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-btn)] border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                  />
                )}
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {native ? t('settings.localData.pathHintNative') : t('settings.localData.pathHintServer')}
              </p>
              {native && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<FolderOpen className="w-4 h-4" strokeWidth={1.75} />}
                  onClick={() => {
                    void nativeRevealDataDir(data?.data_dir).catch((e) => {
                      toast.error({
                        title: t('settings.localData.revealFailed'),
                        description: e instanceof Error ? e.message : String(e),
                      })
                    })
                  }}
                >
                  {t(`settings.localData.${revealLabelKey()}`)}
                </Button>
              )}
            </>
          )}
        </div>

        <div className="flex items-start justify-between gap-4 pt-4 border-t border-border/40">
          <div className="min-w-0 space-y-1">
            <div className="text-base font-medium text-foreground">{t('settings.localData.shadowTitle')}</div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('settings.localData.shadowHint')}
            </p>
          </div>
          <Toggle checked={enabled} onChange={(v) => void handleToggle(v)} disabled={!data} />
        </div>
      </div>
    </SettingsCard>
  )
}
