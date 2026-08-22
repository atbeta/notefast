/**
 * 服务可达性总览：
 *  - 顶栏小红点 + "服务不可达" 文案（始终在 header 内显示 offline 状态）
 *  - 内容区顶部 banner：详情 + 重试按钮 + "上次错误" 摘要
 *
 * 设计取舍：
 *  - 不是 modal / toast——用户做编辑时也会看到，但只是顶部一条窄带，
 *    不抢焦点
 *  - "重试"只是手动触发一次探测，治标不治本（用户得查 server 端为什么挂），
 *    但能避免「等下一个 8s 周期」的等待感
 *  - auto-recovery：探测成功（连续 1 次成功）即从 offline 回到 online，
 *    banner 自动消失，无需用户操作
 */

import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { forceHealthProbe, useServerHealth } from '../hooks/useServerHealth'

export function ServerHealthDot() {
  const { status } = useServerHealth()
  const { t } = useTranslation()
  if (status === 'online') return null
  if (status === 'offline') {
    return (
      <span
        aria-label={t('serverHealth.offline')}
        className="inline-flex items-center gap-1.5 text-xs text-destructive font-medium"
      >
        <span className="relative inline-flex w-1.5 h-1.5">
          <span className="absolute inset-0 rounded-full bg-destructive/40 animate-ping" />
          <span className="relative inline-block w-1.5 h-1.5 rounded-full bg-destructive" />
        </span>
        {t('serverHealth.offline')}
      </span>
    )
  }
  return (
    <span
      aria-label={t('serverHealth.checking')}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
      {t('serverHealth.checking')}
    </span>
  )
}

export function ServerOfflineBanner() {
  const { status, lastError } = useServerHealth()
  const { t } = useTranslation()
  if (status !== 'offline') return null
  return (
    <div
      role="alert"
      className="w-full bg-destructive/8 border-b border-destructive/20 px-4 py-2 text-sm text-destructive flex items-center gap-3"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
      <span className="flex-1 min-w-0 truncate">
        {t('serverHealth.offlineBanner')}
        {lastError && (
          <span className="ml-2 text-destructive/70 font-mono text-xs">（{lastError}）</span>
        )}
      </span>
      <button
        type="button"
        onClick={forceHealthProbe}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-destructive/30 hover:bg-destructive/10 transition-colors text-xs"
      >
        <RefreshCw className="w-3 h-3" strokeWidth={1.75} />
        {t('serverHealth.retry')}
      </button>
    </div>
  )
}