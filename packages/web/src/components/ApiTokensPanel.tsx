import { useState, useEffect, useCallback } from 'react'
import { Key, Plus, Trash2, Copy, Check, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'

interface ApiTokenView {
  token_id: string
  name: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
}

export default function ApiTokensPanel() {
  const [tokens, setTokens] = useState<ApiTokenView[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [scopeRead, setScopeRead] = useState(true)
  const [scopeWrite, setScopeWrite] = useState(true)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const toast = useToast()

  const loadTokens = useCallback(async () => {
    try {
      const data = await api.get<ApiTokenView[]>('/api-tokens')
      if (Array.isArray(data)) setTokens(data)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTokens() }, [loadTokens])

  async function handleCreate() {
    if (!name.trim()) return
    const scopes: string[] = []
    if (scopeRead) scopes.push('read')
    if (scopeWrite) scopes.push('write')
    if (scopes.length === 0) {
      toast.error({ title: '请至少选择一个 scope' })
      return
    }
    try {
      const data = await api.post<{ token: string }>('/api-tokens', { name: name.trim(), scopes })
      if (data?.token) {
        setNewToken(data.token)
        setName('')
        setScopeRead(true)
        setScopeWrite(true)
        setShowForm(false)
        loadTokens()
      }
    } catch {
      toast.error({ title: '创建失败' })
    }
  }

  async function handleRevoke(tokenId: string) {
    try {
      await api.del(`/api-tokens/${tokenId}`)
      loadTokens()
    } catch {
      toast.error({ title: '撤销失败' })
    }
  }

  function copyToken() {
    if (!newToken) return
    navigator.clipboard.writeText(newToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }

  function dismissNewToken() {
    setNewToken(null)
    setCopied(false)
  }

  if (loading) return <div className="rounded-xl border border-border bg-card px-5 py-4 text-[12px] text-muted-foreground">加载中...</div>

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Key className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
          <div>
            <div className="text-[13.5px] font-medium text-foreground">已授权的 API Token</div>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              为外部工具、MCP 客户端或脚本创建独立 Token，支持读写权限拆分与独立撤销。
            </p>
          </div>
        </div>
        <ActionButton onAction={() => setShowForm(!showForm)} variant="ghost" size="sm">
          <Plus className="w-3.5 h-3.5 mr-1" />
          新建
        </ActionButton>
      </div>

      {showForm && (
        <div className="border-t border-border px-5 py-4 space-y-3 bg-muted/30">
          <input
            type="text"
            placeholder="Token 名称（如 desktop-mac）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[13px] text-foreground cursor-pointer">
              <input type="checkbox" checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} className="rounded" />
              read
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-foreground cursor-pointer">
              <input type="checkbox" checked={scopeWrite} onChange={(e) => setScopeWrite(e.target.checked)} className="rounded" />
              write
            </label>
          </div>
          <div className="flex items-center gap-2">
            <ActionButton onAction={handleCreate} disabled={!name.trim()} variant="primary" size="sm">创建</ActionButton>
            <ActionButton onAction={() => setShowForm(false)} variant="ghost" size="sm">取消</ActionButton>
          </div>
        </div>
      )}

      {newToken && (
        <div className="border-t border-border px-5 py-4 space-y-3 bg-amber-50 dark:bg-amber-950/20">
          <div className="flex items-center gap-2 text-[13px] font-medium text-amber-700 dark:text-amber-400">
            <Key className="w-3.5 h-3.5" />
            新 Token 已生成（仅显示一次）
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-100 dark:bg-amber-950/50 px-3 py-2 text-[13px] font-mono text-foreground break-all select-all">
              {newToken}
            </code>
            <ActionButton onAction={copyToken} variant="ghost" size="sm">
              {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
            </ActionButton>
            <ActionButton onAction={dismissNewToken} variant="ghost" size="sm">
              <X className="w-3.5 h-3.5" />
            </ActionButton>
          </div>
          <p className="text-[11px] text-amber-600/80 dark:text-amber-500/80">
            请立即复制并安全保存。关闭此提示后无法再次查看完整 Token。
          </p>
        </div>
      )}

      {tokens.length > 0 && (
        <div className="border-t border-border">
          {tokens.map((t) => (
            <div key={t.token_id} className="flex items-center justify-between gap-4 px-5 py-3 border-b border-border last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground truncate">{t.name}</div>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                  <span>{t.scopes.join(', ')}</span>
                  <span>·</span>
                  <span>{new Date(t.created_at).toLocaleDateString()}</span>
                  {t.last_used_at && (
                    <>
                      <span>·</span>
                      <span>最后使用: {new Date(t.last_used_at).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </div>
              <ActionButton onAction={() => handleRevoke(t.token_id)} variant="ghost" size="sm" className="text-red-500 hover:text-red-600 shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </ActionButton>
            </div>
          ))}
        </div>
      )}

      {tokens.length === 0 && !showForm && (
        <div className="border-t border-border px-5 py-4 text-[12px] text-muted-foreground">
          暂无已授权的 Token。点击「新建」创建第一个。
        </div>
      )}
    </div>
  )
}
