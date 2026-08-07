/**
 * 采集面板：bookmarklet 生成器 + iOS 快捷指令 / curl 示例。
 * 所有通道统一走 POST /api/v1/import/markdown（source 去重语义见 docs/capture.md）；
 * 生成逻辑在 lib/bookmarklet.ts（纯函数，有单测）。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Copy, Check } from 'lucide-react'
import { SettingsCard } from './settings/ui'
import { Button } from './ui'
import { buildBookmarkletCode } from '../lib/bookmarklet'

export default function CapturePanel() {
  const { t } = useTranslation()
  const [endpoint, setEndpoint] = useState(() => window.location.origin)
  /** 用户粘贴的令牌明文（token 只在创建时显示一次，无法回显已有令牌） */
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState<'bookmarklet' | 'curl' | null>(null)

  const bookmarklet = useMemo(
    () =>
      buildBookmarkletCode({
        endpoint: endpoint.trim() || window.location.origin,
        token: token.trim() || t('capture.tokenPlaceholder'),
        labels: { success: t('capture.alertSuccess'), failure: t('capture.alertFailed') },
      }),
    [endpoint, token, t],
  )

  const curlExample = useMemo(() => {
    const ep = (endpoint.trim() || window.location.origin).replace(/\/+$/, '')
    return [
      `curl -X POST "${ep}/api/v1/import/markdown" \\`,
      `  -H "Authorization: Bearer ${token.trim() || t('capture.tokenPlaceholder')}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"markdown":"${t('capture.curlBody')}","title":"...","status":"inbox","source":{"provider":"ios-shortcut","external_id":"https://example.com/page"}}'`,
    ].join('\n')
  }, [endpoint, token, t])

  const copy = async (text: string, kind: 'bookmarklet' | 'curl') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(null), 2500)
    } catch { /* clipboard 不可用时静默 */ }
  }

  const inputCls =
    'w-full px-3 py-1.5 rounded-md border border-border bg-background outline-none transition-all focus:ring-1 focus:ring-primary/30 focus:border-primary/50 placeholder:text-muted-foreground/40 font-mono text-[13px]'

  return (
    <SettingsCard
      title={t('capture.title')}
      icon={<Bookmark className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('capture.helpTip')}
    >
      <div className="space-y-6">
        {/* Bookmarklet */}
        <div className="space-y-3">
          <div className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{t('capture.bookmarkletLabel')}</div>
          <p className="text-[12.5px] text-muted-foreground leading-relaxed">{t('capture.bookmarkletDesc')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-muted-foreground">{t('capture.endpointLabel')}</label>
              <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className={inputCls} spellCheck={false} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-muted-foreground">{t('capture.tokenLabel')}</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('capture.tokenPlaceholder')}
                className={inputCls}
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/70">{t('capture.tokenHint')}</p>
          <pre className="rounded-lg border border-border bg-muted/30 p-3.5 text-[12px] font-mono leading-[1.7] overflow-x-auto text-foreground/90 whitespace-pre-wrap break-all select-all">
            {bookmarklet}
          </pre>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void copy(bookmarklet, 'bookmarklet')}>
              {copied === 'bookmarklet' ? <Check className="w-3.5 h-3.5 text-emerald-600 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
              {copied === 'bookmarklet' ? t('capture.copied') : t('capture.copyCode')}
            </Button>
            <span className="text-[11px] text-muted-foreground/70">{t('capture.saveAsBookmark')}</span>
          </div>
          <p className="text-[11px] text-amber-600/90 dark:text-amber-500/80 leading-relaxed">{t('capture.tokenWarning')}</p>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{t('capture.corsHint')}</p>
        </div>

        {/* iOS 快捷指令 */}
        <div className="space-y-3">
          <div className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{t('capture.iosLabel')}</div>
          <ol className="list-decimal pl-4 text-[12.5px] text-muted-foreground leading-relaxed space-y-1">
            <li>{t('capture.iosStep1')}</li>
            <li>{t('capture.iosStep2')}</li>
            <li>{t('capture.iosStep3')}</li>
          </ol>
          <pre className="rounded-lg border border-border bg-muted/30 p-3.5 text-[12px] font-mono leading-[1.7] overflow-x-auto text-foreground/90 select-all">
            {curlExample}
          </pre>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void copy(curlExample, 'curl')}>
              {copied === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-600 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
              {copied === 'curl' ? t('capture.copied') : t('capture.copyCurl')}
            </Button>
            <span className="text-[11px] text-muted-foreground/70">{t('capture.iosNoCors')}</span>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
