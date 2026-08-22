/**
 * 登录弹框
 *
 * 当服务端 /api/v1/auth/mode 返回 passwordRequired=true 时显示。
 * 用户输入密码 → 服务端返回会话 token → 客户端存 token（非密码）→ 后续请求走 Bearer。
 * 勾选「保持登录」→ localStorage 7 天滑动过期；不勾选 → sessionStorage 会话级。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Loader2, Check } from 'lucide-react'
import { saveSessionToken } from '../hooks/useAPI'

export default function AuthPrompt() {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError('')
    const pw = password.trim()
    try {
      const res = await fetch(`/api/v1/auth/session?remember=${remember ? '1' : '0'}`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa('admin:' + pw) },
      })
      if (!res.ok) {
        setError(t('auth.wrongPassword'))
        setSubmitting(false)
        return
      }
      const data = await res.json() as { session: boolean; token?: string }
      if (data.token) {
        saveSessionToken(data.token, remember)
      }
      window.location.reload()
    } catch {
      setError(t('auth.networkError'))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-auth flex items-center justify-center bg-background animate-fade-in">
      <form
        onSubmit={handleSubmit}
        className="w-[360px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-7 shadow-floating space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-foreground text-background grid place-items-center">
            <Lock className="w-4 h-4" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('auth.loginTitle')}</h1>
            <p className="text-[11.5px] text-muted-foreground mt-0.5">
              {t('auth.passwordRequired')}
            </p>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="auth-pw">{t('auth.password')}</label>
          <input
            id="auth-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError('') }}
            placeholder="••••••••"
            disabled={submitting}
            className="input-mono"
          />
          {error && (
            <p className="mt-1.5 text-[11.5px] text-destructive">{error}</p>
          )}
          <button
            type="button"
            role="checkbox"
            aria-checked={remember}
            onClick={() => setRemember((v) => !v)}
            className="mt-3 flex items-center gap-2 select-none cursor-pointer w-fit group"
          >
            <span
              className={`w-4 h-4 rounded-md border grid place-items-center transition-all ${
                remember
                  ? 'bg-foreground border-foreground text-background'
                  : 'border-border-strong/60 bg-transparent group-hover:border-foreground/40'
              }`}
            >
              {remember && <Check className="w-3 h-3" strokeWidth={3} />}
            </span>
            <span className="text-[12px] text-foreground/80">{t('auth.rememberMe')}</span>
          </button>
          <p className="text-[10.5px] text-muted-foreground/70 mt-1.5 leading-relaxed">
            {remember
              ? t('auth.rememberDesc')
              : t('auth.noRememberDesc')}
          </p>
        </div>

        <button
          type="submit"
          disabled={!password.trim() || submitting}
          className="btn-primary-custom w-full justify-center"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('auth.loggingIn')}
            </>
          ) : (
            t('auth.login')
          )}
        </button>
      </form>
    </div>
  )
}
