/**
 * 文档分享 popover（锚在触发按钮下，Notion 式轻量面板）
 *
 * 语义与后端一致：
 * - 开启幂等；关闭后旧链接立即 404；重开全新 token
 * - 有效期默认永不过期；可选 1/7/30 天
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, Globe, Loader2, Link2, Trash2 } from 'lucide-react'
import { api, ApiError } from '../hooks/useAPI'
import { useToast } from './ui'

type ExpiryChoice = 'never' | '1' | '7' | '30'

export interface ShareInfo {
  shared: boolean
  token?: string
  path?: string
  created_at?: string
  expires_at?: string | null
}

interface ShareDialogProps {
  docId: string
  onClose: () => void
  /** 锚点（文档顶栏按钮）；缺省则靠视口右上 */
  anchorRef?: RefObject<HTMLElement | null>
  /** 分享开关变化时回调（用于顶栏图标态） */
  onSharedChange?: (shared: boolean) => void
}

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
  const daysLeft = Math.max(0, Math.round((d.getTime() - Date.now()) / 86_400_000))
  return `${dateText} 失效（还剩 ${daysLeft} 天）`
}

const PANEL_W = 360

export default function ShareDialog({ docId, onClose, anchorRef, onSharedChange }: ShareDialogProps) {
  const toast = useToast()
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [expiry, setExpiry] = useState<ExpiryChoice>('never')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const place = useCallback(() => {
    const el = anchorRef?.current
    if (el) {
      const r = el.getBoundingClientRect()
      let left = r.right - PANEL_W
      left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - 8))
      let top = r.bottom + 6
      const approxH = 280
      if (top + approxH > window.innerHeight - 8 && r.top > approxH) {
        top = r.top - 6 // 向上展开时由 style 用 transform 或 bottom；此处简化：仍向下但夹紧
        top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - approxH - 8))
      }
      setPos({ top, left })
      return
    }
    setPos({
      top: 72,
      left: Math.max(8, window.innerWidth - PANEL_W - 24),
    })
  }, [anchorRef])

  useLayoutEffect(() => {
    place()
  }, [place])

  useEffect(() => {
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef?.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose, anchorRef])

  useEffect(() => {
    let cancelled = false
    api.get<ShareInfo>(`/docs/${docId}/share`)
      .then((r) => {
        if (cancelled) return
        setInfo(r)
        setExpiry(inferExpiryChoice(r.expires_at))
        onSharedChange?.(r.shared)
      })
      .catch(() => {
        if (cancelled) return
        setInfo({ shared: false })
        onSharedChange?.(false)
      })
    return () => { cancelled = true }
  }, [docId, onSharedChange])

  const shareUrl = info?.path ? `${window.location.origin}${info.path}` : ''

  const setSharedState = useCallback((next: ShareInfo) => {
    setInfo(next)
    onSharedChange?.(next.shared)
  }, [onSharedChange])

  const handleEnable = useCallback(async () => {
    setBusy(true)
    try {
      let body: Record<string, unknown> = {}
      try {
        const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, body)
        setSharedState({ ...r, shared: true })
        setExpiry(inferExpiryChoice(r.expires_at))
        return
      } catch (err) {
        const needsConfirm =
          err instanceof ApiError && err.status === 409 &&
          (err.body as { error?: string } | null)?.error === 'ai_exclude_share_needs_confirm'
        if (!needsConfirm) throw err
        const confirmed = window.confirm(
          '这篇文档已标记「对 AI 隐藏」。\n\n开启公开分享后，任何人获得链接均可阅读全文，无需登录。确认仍要开启分享吗？',
        )
        if (!confirmed) return
        body = { confirm_ai_exclude: true }
      }
      const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, body)
      setSharedState({ ...r, shared: true })
      setExpiry(inferExpiryChoice(r.expires_at))
    } catch {
      toast.error({ title: '开启分享失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast, setSharedState])

  const handleDisable = useCallback(async () => {
    setBusy(true)
    try {
      await api.del(`/docs/${docId}/share`)
      setSharedState({ shared: false })
      setCopied(false)
    } catch {
      toast.error({ title: '关闭分享失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast, setSharedState])

  const handleExpiryChange = useCallback(async (choice: ExpiryChoice) => {
    setExpiry(choice)
    setBusy(true)
    try {
      const r = await api.put<ShareInfo & { token: string; path: string }>(`/docs/${docId}/share`, {
        expires_in_days: choice === 'never' ? null : Number(choice),
      })
      setSharedState({ ...r, shared: true })
    } catch {
      toast.error({ title: '调整有效期失败' })
    } finally {
      setBusy(false)
    }
  }, [docId, toast, setSharedState])

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

  if (!pos) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="分享文档"
      className="fixed z-[80] w-[360px] max-w-[calc(100vw-16px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="px-3.5 pt-3 pb-2 flex items-center gap-2 border-b border-border/60">
        <Globe className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
        <span className="text-[13px] font-medium text-foreground">分享</span>
      </div>

      <div className="p-3.5 space-y-3">
        {info === null ? (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
            加载中…
          </div>
        ) : info.shared ? (
          <>
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-md bg-muted/70 grid place-items-center shrink-0">
                <Globe className="w-3.5 h-3.5 text-foreground/80" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">任何人可通过链接访问</p>
                <p className="text-[12px] text-muted-foreground mt-0.5 leading-relaxed">
                  获得链接即可阅读，无需登录
                </p>
              </div>
              <span className="shrink-0 text-[11.5px] text-muted-foreground px-1.5 py-0.5 rounded border border-border/70">
                可查看
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px] font-mono text-foreground focus:outline-none focus:border-foreground/25"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors"
                title="复制链接"
              >
                {copied
                  ? <Check className="w-3.5 h-3.5 text-green-600" strokeWidth={2} />
                  : <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-muted-foreground">有效期</span>
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
              <p className="text-[11.5px] text-muted-foreground/70 -mt-1">将于 {expiryText}</p>
            )}

            <div className="pt-1 border-t border-border/60 flex justify-end">
              <button
                type="button"
                onClick={handleDisable}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-destructive rounded-md hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" strokeWidth={1.75} />
                关闭分享
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-muted-foreground leading-relaxed">
              开启后生成公开只读链接，任何人无需登录即可阅读。可随时关闭。
            </p>
            <button
              type="button"
              onClick={handleEnable}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />}
              开启公开链接
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** 拉取文档当前是否已公开分享（顶栏图标态） */
export async function fetchDocShared(docId: string): Promise<boolean> {
  try {
    const r = await api.get<ShareInfo>(`/docs/${docId}/share`)
    return r.shared === true
  } catch {
    return false
  }
}
