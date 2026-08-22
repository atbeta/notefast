import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { SettingsSection } from '../../components/settings/ui'
import { useApiQuery } from '../../hooks/useApiQuery'
import { api } from '../../hooks/useAPI'
import {
  RELEASES_PAGE,
  checkLatestRelease,
  type CheckReleaseResult,
} from '../../lib/checkRelease'

/**
 * 关于：Logo + 版本 + 手动检查更新（引导下载，不自动安装）。
 * 启动不联网；仅用户点击「检查更新」才请求 GitHub。
 */
export default function SettingsAbout() {
  const { t } = useTranslation()
  const { data: versionInfo } = useApiQuery(() => api.get<{ version: string }>('/version'), [])
  const version = versionInfo?.version ?? null

  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckReleaseResult | null>(null)

  const onCheck = async () => {
    if (!version || checking) return
    setChecking(true)
    setResult(null)
    const r = await checkLatestRelease(version)
    setResult(r)
    setChecking(false)
  }

  return (
    <SettingsSection id="about" title={t('settings.tabs.about')}>
      <div className="rounded-lg border border-border/60 bg-card shadow-card p-6 sm:p-7">
        <div className="flex flex-col items-center text-center gap-3 sm:gap-4">
          <img
            src="/favicon.svg"
            alt=""
            width={56}
            height={56}
            className="w-14 h-14 rounded-xl shadow-card"
            draggable={false}
          />
          <div>
            <div className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              NoteFast
            </div>
            <p className="mt-1 text-base text-muted-foreground">
              {version
                ? t('settings.about.version', { version })
                : t('settings.about.versionLoading')}
            </p>
          </div>
          <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
            {t('settings.about.blurb')}
          </p>
        </div>

        <div className="mt-6 pt-5 border-t border-border/50 space-y-3">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => void onCheck()}
              disabled={!version || checking}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-btn)] border border-border bg-background text-base font-medium text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {checking ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
              )}
              {t('settings.about.checkUpdates')}
            </button>
            <a
              href={RELEASES_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-btn)] text-base font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} />
              {t('settings.about.openReleases')}
            </a>
          </div>

          {result?.status === 'latest' && (
            <p className="text-center text-sm text-success">
              {t('settings.about.upToDate', { version: result.current })}
            </p>
          )}
          {result?.status === 'update' && (
            <p className="text-center text-sm text-foreground">
              {t('settings.about.updateAvailable', {
                latest: result.latest.version,
                current: result.current,
              })}{' '}
              <a
                href={result.latest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {t('settings.about.download')}
              </a>
            </p>
          )}
          {result?.status === 'error' && (
            <p className="text-center text-sm text-muted-foreground">
              {t('settings.about.checkFailed')}{' '}
              <a
                href={RELEASES_PAGE}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t('settings.about.openReleases')}
              </a>
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground/75 leading-relaxed">
            {t('settings.about.manualHint')}
          </p>
        </div>
      </div>
    </SettingsSection>
  )
}
