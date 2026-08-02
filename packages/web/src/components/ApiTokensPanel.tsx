import { useState, useEffect, useCallback } from 'react'
import { Key, Plus, Trash2, Copy, Check, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import { SettingsCard, StatusBadge } from './settings/ui'

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
      toast.error({ title: '请至少选择一项权限' })
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

  if (loading) return <div className="rounded-lg border border-border bg-card px-5 py-4 text-[12px] text-muted-foreground">加载中...</div>

  return (
    <SettingsCard
      title="API Token"
      icon={<Key className="w-4 h-4" strokeWidth={1.75} />}
      statusBadge={<StatusBadge active={tokens.length > 0} label={tokens.length > 0 ? `${tokens.length} 个活跃` : '无活跃'} />}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[12.5px] text-muted-foreground leading-relaxed">
            为外部工具、MCP 客户端或脚本创建独立 Token，支持读写权限拆分与独立撤销。
          </div>
          <ActionButton onAction={() => setShowForm(!showForm)} variant="secondary" size="sm">
            <Plus className="w-3.5 h-3.5 mr-1" />
            新建 Token
          </ActionButton>
        </div>

        {showForm && (
          <div className="rounded-lg border border-border p-4 space-y-4 bg-accent/20">
            <input
              type="text"
              placeholder="Token 名称 (例如 desktop-mac)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
              autoFocus
            />
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
                <input type="checkbox" checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} className="rounded border-border" />
                <span>read</span>
              </label>
              <label className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
                <input type="checkbox" checked={scopeWrite} onChange={(e) => setScopeWrite(e.target.checked)} className="rounded border-border" />
                <span>write</span>
              </label>
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-border/40">
              <ActionButton onAction={handleCreate} disabled={!name.trim()}>创建</ActionButton>
              <ActionButton onAction={() => setShowForm(false)} variant="ghost">取消</ActionButton>
            </div>
          </div>
        )}

        {newToken && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
                <Key className="w-3.5 h-3.5" />
                新 Token 已生成（仅显示一次）
              </div>
              <button onClick={dismissNewToken} className="text-emerald-600/60 hover:text-emerald-600 p-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-950/50 px-3 py-2 text-[13px] font-mono text-emerald-900 dark:text-emerald-100 break-all select-all">
                {newToken}
              </code>
              <ActionButton onAction={copyToken} variant="secondary" className="shrink-0">
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </ActionButton>
            </div>
            <p className="text-[11px] text-emerald-600/80 dark:text-emerald-500/80">
              请立即复制并安全保存。关闭此提示后无法再次查看完整 Token。
            </p>
          </div>
        )}

        {tokens.length > 0 ? (
          <div className="rounded-lg border border-border overflow-hidden">
            {tokens.map((t, i) => (
              <div key={t.token_id} className={`flex items-center justify-between gap-4 px-4 py-3 ${i !== tokens.length - 1 ? 'border-b border-border/50' : ''} bg-background`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-[13px] font-medium text-foreground truncate">{t.name}</div>
                    <div className="flex gap-1">
                      {t.scopes.map(s => <span key={s} className="px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-wider font-mono bg-accent text-muted-foreground border border-border/50">{s}</span>)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground font-mono">
                    <span>创建: {new Date(t.created_at).toLocaleDateString()}</span>
                    {t.last_used_at && (
                      <>
                        <span>·</span>
                        <span>最后使用: {new Date(t.last_used_at).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <button 
                  onClick={() => handleRevoke(t.token_id)} 
                  className="p-2 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0 transition-colors"
                  title="撤销 Token"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        ) : !showForm && (
          <div className="rounded-lg border border-border border-dashed p-8 text-center text-[12.5px] text-muted-foreground">
            暂无已授权的 Token。点击「新建 Token」创建第一个。
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
