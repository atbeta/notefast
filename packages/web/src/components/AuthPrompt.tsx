/**
 * 登录弹框
 *
 * 当服务端 /api/v1/auth/mode 返回 passwordRequired=true 时显示。
 * 用户输入密码 → 写入 sessionStorage → 刷新页面让所有 API 调用带 header。
 */

import { useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import { setStoredPassword } from '../hooks/useAPI'

export interface AuthPromptProps {
  /** 探测失败时（如 fetch 抛错）也用这个 fallback 显示密码框 */
  reason?: 'password_required' | 'wrong_password' | 'unknown'
}

export default function AuthPrompt({ reason = 'password_required' }: AuthPromptProps) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    // 写 sessionStorage 并 reload —— 让所有 hooks 重新挂载时携带新 header
    setStoredPassword(password.trim())
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm animate-fade-in">
      <form
        onSubmit={handleSubmit}
        className="w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-card p-7 shadow-[var(--shadow-floating)] space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-foreground text-background grid place-items-center">
            <Lock className="w-4 h-4" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em]">NoteFast 登录</h1>
            <p className="text-[11.5px] text-muted-foreground mt-0.5">
              {reason === 'wrong_password'
                ? '密码不正确，请重试'
                : '此实例已开启访问密码'}
            </p>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="auth-pw">密码</label>
          <input
            id="auth-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={submitting}
            className="input-mono"
          />
          <p className="text-[10.5px] text-muted-foreground/70 mt-1.5 leading-relaxed">
            密码仅保存在本浏览器会话（sessionStorage），关闭浏览器后自动清除。
          </p>
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <button
          type="submit"
          disabled={!password.trim() || submitting}
          className="btn-primary-custom w-full justify-center"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              登录中…
            </>
          ) : (
            '登录'
          )}
        </button>
      </form>
    </div>
  )
}