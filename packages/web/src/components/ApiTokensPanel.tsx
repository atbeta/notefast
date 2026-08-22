import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Key, Plus, Trash2, Copy, Check, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { currentLocale } from '../lib/time'
import { ActionButton, Tooltip, useToast } from './ui'
import { SettingsCard, StatusBadge } from './settings/ui'

interface ApiTokenView {
  token_id: string
  name: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
}

export default function ApiTokensPanel() {
  const { t } = useTranslation()
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
      toast.error({ title: t('apiTokens.scopeRequired') })
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
      toast.error({ title: t('apiTokens.createFailed') })
    }
  }

  async function handleRevoke(tokenId: string) {
    try {
      await api.del(`/api-tokens/${tokenId}`)
      loadTokens()
    } catch {
      toast.error({ title: t('apiTokens.revokeFailed') })
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

  if (loading) return <div className="rounded-lg border border-border bg-card px-5 py-4 text-[12px] text-muted-foreground">{t('common.loading')}</div>

  return (
    <SettingsCard
      title={t('apiTokens.title')}
      icon={<Key className="w-4 h-4" strokeWidth={1.75} />}
      statusBadge={<StatusBadge active={tokens.length > 0} label={tokens.length > 0 ? t('apiTokens.activeCount', { n: tokens.length }) : t('apiTokens.noActive')} />}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[12.5px] text-muted-foreground leading-relaxed">
            {t('apiTokens.description')}
          </div>
          <ActionButton onAction={() => setShowForm(!showForm)} variant="secondary" size="sm">
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('apiTokens.createNew')}
          </ActionButton>
        </div>

        {showForm && (
          <div className="rounded-lg border border-border p-4 space-y-4 bg-accent/20">
            <input
              type="text"
              placeholder={t('apiTokens.namePlaceholder')}
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
              <ActionButton onAction={handleCreate} disabled={!name.trim()}>{t('apiTokens.create')}</ActionButton>
              <ActionButton onAction={() => setShowForm(false)} variant="ghost">{t('common.cancel')}</ActionButton>
            </div>
          </div>
        )}

        {newToken && (
          <div className="rounded-lg border border-success/25 bg-success-soft p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[13px] font-medium text-success">
                <Key className="w-3.5 h-3.5" />
                {t('apiTokens.generatedOnce')}
              </div>
              <button onClick={dismissNewToken} className="text-success/60 hover:text-success p-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-[13px] font-mono text-success break-all select-all">
                {newToken}
              </code>
              <ActionButton onAction={copyToken} variant="secondary" className="shrink-0">
                {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              </ActionButton>
            </div>
            <p className="text-[11px] text-success/80">
              {t('apiTokens.saveNow')}
            </p>
          </div>
        )}

        {tokens.length > 0 ? (
          <div className="rounded-lg border border-border overflow-hidden">
            {tokens.map((tok, i) => (
              <div key={tok.token_id} className={`flex items-center justify-between gap-4 px-4 py-3 ${i !== tokens.length - 1 ? 'border-b border-border/50' : ''} bg-background`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-[13px] font-medium text-foreground truncate">{tok.name}</div>
                    <div className="flex gap-1">
                      {tok.scopes.map(s => <span key={s} className="px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-wider font-mono bg-accent text-muted-foreground border border-border/50">{s}</span>)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground font-mono">
                    <span>{t('apiTokens.createdAt', { date: new Date(tok.created_at).toLocaleDateString(currentLocale()) })}</span>
                    {tok.last_used_at && (
                      <>
                        <span>·</span>
                        <span>{t('apiTokens.lastUsed', { date: new Date(tok.last_used_at).toLocaleDateString(currentLocale()) })}</span>
                      </>
                    )}
                  </div>
                </div>
                <Tooltip label={t('apiTokens.revokeTitle')}>
                  <button
                    onClick={() => handleRevoke(tok.token_id)}
                    className="p-2 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0 transition-colors"
                    aria-label={t('apiTokens.revokeTitle')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        ) : !showForm && (
          <div className="rounded-lg border border-border border-dashed p-8 text-center text-[12.5px] text-muted-foreground">
            {t('apiTokens.empty')}
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
