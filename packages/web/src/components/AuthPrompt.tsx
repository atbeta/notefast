/**
 * 登录弹框
 *
 * 当服务端 /api/v1/auth/mode 返回 passwordRequired=true 时显示。
 * 用户输入密码 → 默认写 localStorage（7 天滑动过期）→ 刷新页面让所有 API 调用带 header；
 * 取消勾选「保持登录」则退回 sessionStorage 会话级存储。
 */

import { useState } from 'react'
import { Lock, Loader2, Check } from 'lucide-react'
import { setStoredPassword } from '../hooks/useAPI'

export default function AuthPrompt() {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    const pw = password.trim()
    setStoredPassword(pw, remember)
    // 建立会话 cookie（<img> 无法携带 Authorization 头，asset 图片读取走 cookie）
    try {
      await fetch(`/api/v1/auth/session?remember=${remember ? '1' : '0'}`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa('admin:' + pw) },
      })
    } catch { /* cookie 建立失败不阻塞登录（无密码实例也不需要） */ }
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm animate-fade-in">
      <form
        onSubmit={handleSubmit}
        className="w-[360px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-7 shadow-[var(--shadow-floating)] space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-foreground text-background grid place-items-center">
            <Lock className="w-4 h-4" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em]">NoteFast 登录</h1>
            <p className="text-[11.5px] text-muted-foreground mt-0.5">
              此实例已开启访问密码
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
          <button
            type="button"
            role="checkbox"
            aria-checked={remember}
            onClick={() => setRemember((v) => !v)}
            className="mt-3 flex items-center gap-2 select-none cursor-pointer w-fit group"
          >
            <span
              className={`w-4 h-4 rounded-[4px] border grid place-items-center transition-all ${
                remember
                  ? 'bg-foreground border-foreground text-background'
                  : 'border-border-strong/60 bg-transparent group-hover:border-foreground/40'
              }`}
            >
              {remember && <Check className="w-3 h-3" strokeWidth={3} />}
            </span>
            <span className="text-[12px] text-foreground/80">保持登录 7 天</span>
          </button>
          <p className="text-[10.5px] text-muted-foreground/70 mt-1.5 leading-relaxed">
            {remember
              ? '密码保存在本浏览器 localStorage，7 天内每次打开自动续期；公共设备请勿勾选。'
              : '密码仅保存在本浏览器会话（sessionStorage），关闭浏览器后自动清除。'}
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