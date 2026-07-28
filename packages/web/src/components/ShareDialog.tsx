import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Globe, Loader2, Trash2 } from 'lucide-react'
import { api, ApiError } from '../hooks/useAPI'
import { useToast } from './ui'

/**
 * 文档分享弹层：开启/关闭公开只读链接 + 有效期（Notion 同款：默认永不过期）。
 *
 * 语义与后端一致：
 * - 开启幂等（重复开启返回同一链接）
 * - 关闭后旧链接立即 404；重新开启生成全新链接，旧链接永久失效
 * - 有效期可选 1/7/30 天（以调整为起点重算）；到期 = 未分享，公开访问 404
 */

type ExpiryChoice = 'never' | '1' | '7' | '30'

interface ShareInfo {
  shared: boolean
  token?: string
  path?: string
  created_at?: string
  expires_at?: string | null
}

interface ShareDialogProps {
  docId: string
  onClose: () => void
}

/** 从 expires_at 反推最接近的选项（仅作初始展示；调整总是以现在为起点重算） */
function inferExpiryChoice(expiresAt: string | null | undefined): ExpiryChoice {
  if (!expiresAt) return 'never'
  const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'never'
  const days = ms / 86_400_000
  if (days <= 2) return '1'
  if (days <= 8) return '7'
  return '30'
}

function formatExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null
  const d = new Date(expiresAt.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(d.getTime())) return null
  const dateText = d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  // 附带剩余天数：下拉选项是桶（1/7/30），剩余天数才是真实语义，避免误读
  const daysLeft = Math.max(0, Math.round((d.getTime() - Date.now()) / 86_400_000))
  return `${dateText} 失效（还剩 ${daysLeft} 天）`
}

export default function ShareDialog({ docId, onClose }: ShareDialogProps) {
  const toast = useToast()
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [expiry, setExpiry] = useState<ExpiryChoice>('never')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get<ShareInfo>(`/docs/${docId}/share`)
      .then((r) => {
        if (cancelled) return
        setInfo(r)
        setExpiry(inferExpiryChoice(r.expires_at))
      })
      .catch(() => { if (!cancelled) setInfo({ shared: false }) })
    return () => { cancelled = true }
  }, [docId])

  const shareUrl = info?.path ? `${window.location.origin}${info.path}` : ''

  const handleEnable = useCallback(async () => {
    setBusy(true)
    try {
      let body: Record<string, unknown> = {}
      try {
        const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, body)
        setInfo({ ...r, shared: true })
        setExpiry(inferExpiryChoice(r.expires_at))
        return
      } catch (err) {
        // 服务端 guardrail：ai_exclude 文档首次开启需显式确认（409）
        const needsConfirm =
          err instanceof ApiError && err.status === 409 &&
          (err.body as { error?: string } | null)?.error === 'ai_exclude_share_needs_confirm'
        if (!needsConfirm) throw err
        const confirmed = window.confirm(
          '这篇文档已标记「对 AI 隐藏」。\n\n开启公开分享后，任何拿到链接的人无需登录即可阅读全文。确认仍要开启分享吗？',
        )
        if (!confirmed) return
        body = { confirm_ai_exclude: true }
      }
      const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, body)
      setInfo({ ...r, shared: true })
      setExpiry(inferExpiryChoice(r.expires_at))
    } catch {
      toast.error({ title: '开启分享失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast])

  const handleDisable = useCallback(async () => {
    setBusy(true)
    try {
      await api.del(`/docs/${docId}/share`)
      setInfo({ shared: false })
      setCopied(false)
    } catch {
      toast.error({ title: '关闭分享失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast])

  const handleExpiryChange = useCallback(async (choice: ExpiryChoice) => {
    setExpiry(choice)
    setBusy(true)
    try {
      const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, {
        expires_in_days: choice === 'never' ? null : Number(choice),
      })
      setInfo({ ...r, shared: true })
    } catch {
      toast.error({ title: '调整有效期失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error({ title: '复制失败', description: '请手动选择链接复制' })
    }
  }, [shareUrl, toast])

  const expiryText = formatExpiry(info?.expires_at)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl p-5 w-[380px] shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[14px] font-medium text-foreground">
          <Globe className="w-4 h-4" strokeWidth={1.75} />
          分享文档
        </div>

        {info === null ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
            加载中…
          </div>
        ) : info.shared ? (
          <>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              任何获得此链接的人都可以只读访问这篇文档，无需登录。
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] font-mono text-foreground focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="shrink-0 p-2 rounded-lg border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                title="复制链接"
              >
                {copied
                  ? <Check className="w-4 h-4 text-green-600" strokeWidth={2} />
                  : <Copy className="w-4 h-4" strokeWidth={1.75} />}
              </button>
            </div>
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-muted-foreground">链接有效期</span>
              <select
                value={expiry}
                disabled={busy}
                onChange={(e) => handleExpiryChange(e.target.value as ExpiryChoice)}
                className="rounded-md border border-border bg-background px-2 py-1 text-[12.5px] text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 disabled:opacity-50"
              >
                <option value="never">永不过期</option>
                <option value="1">1 天</option>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
              </select>
            </div>
            {expiryText && (
              <p className="text-[12px] text-muted-foreground/70 -mt-1">将于 {expiryText}</p>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-[12px] text-muted-foreground/70">关闭后此链接立即失效</span>
              <button
                onClick={handleDisable}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" strokeWidth={1.75} />
                关闭分享
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              开启后生成一个公开只读链接，任何人无需登录即可阅读这篇文档。可随时关闭，关闭后链接立即失效。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleEnable}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />}
                开启分享
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
