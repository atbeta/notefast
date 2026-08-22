/**
 * MCP 面板：展示 NoteFast 自带的 MCP 端点、一键复制连接配置、生成连接令牌、能力清单。
 *
 * 所有形态（浏览器 / macOS / Windows 原生壳）共享此 Web 层；端点 URL 取自
 * location.origin（壳内即内嵌服务器 origin），无需按壳分支。
 * 令牌明文只在生成时显示一次（服务端不存明文，见 api/apiTokens.ts）。
 */

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Copy, Check, Key } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { SettingsCard, StatusBadge } from './settings/ui'
import { Button, Tooltip, useToast } from './ui'

interface McpTool {
  name: string
  description: string
}

/** 示例配置格式：OpenCode 与 Claude/Cursor 的 MCP 配置结构不同，优雅兼顾 */
type ConfigFormat = 'opencode' | 'claude'
const FORMAT_STORAGE_KEY = 'notefast.mcp.configFormat'

function readFormat(): ConfigFormat {
  try {
    return localStorage.getItem(FORMAT_STORAGE_KEY) === 'claude' ? 'claude' : 'opencode'
  } catch {
    return 'opencode'
  }
}

export default function McpPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [tools, setTools] = useState<McpTool[]>([])
  const [generating, setGenerating] = useState(false)
  /** 本次会话生成的令牌明文（只显示一次；刷新后丢失） */
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<'config' | 'token' | null>(null)
  const [format, setFormat] = useState<ConfigFormat>(readFormat)

  const endpoint = useMemo(() => `${window.location.origin}/mcp`, [])

  useEffect(() => {
    api.get<McpTool[]>('/mcp/tools')
      .then((r) => { if (Array.isArray(r)) setTools(r) })
      .catch(() => {})
  }, [])

  const switchFormat = (next: ConfigFormat) => {
    setFormat(next)
    setCopied(null)
    try { localStorage.setItem(FORMAT_STORAGE_KEY, next) } catch { /* ignore */ }
  }

  const auth = `Bearer ${revealedToken ?? t('mcp.tokenPlaceholder')}`
  const configJson = useMemo(() => {
    const base = { url: endpoint, headers: { Authorization: auth } }
    return JSON.stringify(
      format === 'opencode'
        ? {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              notefast: { type: 'remote', ...base, enabled: true },
            },
          }
        : {
            mcpServers: { notefast: base },
          },
      null,
      2,
    )
  }, [endpoint, auth, format])

  const generateToken = async () => {
    setGenerating(true)
    try {
      const data = await api.post<{ token: string }>('/api-tokens', {
        name: t('mcp.tokenName'),
        scopes: ['read', 'write'],
      })
      if (data?.token) setRevealedToken(data.token)
    } catch {
      toast.error({ title: t('mcp.tokenFailed') })
    } finally {
      setGenerating(false)
    }
  }

  const copy = async (text: string, kind: 'config' | 'token') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(null), 2500)
    } catch { /* clipboard 不可用时静默 */ }
  }

  const sortedTools = useMemo(() => [...tools].sort((a, b) => a.name.localeCompare(b.name)), [tools])

  return (
    <SettingsCard
      title={t('mcp.title')}
      icon={<Bot className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('mcp.helpTip')}
      statusBadge={<StatusBadge active label={t('mcp.enabled')} />}
    >
      <div className="space-y-6">
        {/* 端点 */}
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('mcp.endpointLabel')}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-mono text-foreground break-all select-all">
              {endpoint}
            </code>
            <Button variant="secondary" onClick={() => void copy(endpoint, 'config')} className="shrink-0">
              {copied === 'config' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>

        {/* 连接配置 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('mcp.configLabel')}</div>
            <div className="flex items-center rounded-md border border-border bg-muted/40 p-0.5">
              {(['opencode', 'claude'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => switchFormat(f)}
                  className={`px-2 py-0.5 rounded-md text-xs transition-colors ${
                    format === f
                      ? 'bg-popover text-foreground shadow-card border border-border/70'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f === 'opencode' ? t('mcp.formatOpencode') : t('mcp.formatClaude')}
                </button>
              ))}
            </div>
          </div>
          <pre className="rounded-lg border border-border bg-muted/30 p-3.5 text-sm font-mono leading-[1.7] overflow-x-auto text-foreground/90">
            {configJson}
          </pre>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void copy(configJson, 'config')}>
              {copied === 'config' ? <Check className="w-3.5 h-3.5 text-success mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
              {copied === 'config' ? t('mcp.copied') : t('mcp.copyConfig')}
            </Button>
            <span className="text-xs text-muted-foreground/70">
              {format === 'opencode' ? t('mcp.configHintOpencode') : t('mcp.configHintClaude')}
            </span>
          </div>
        </div>

        {/* 令牌 */}
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('mcp.tokenLabel')}</div>
          <p className="text-sm text-muted-foreground leading-relaxed">{t('mcp.tokenDesc')}</p>
          {revealedToken ? (
            <div className="rounded-lg border border-success/25 bg-success-soft p-3.5 space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-success/25 bg-success/10 px-2.5 py-1.5 text-sm font-mono text-success break-all select-all">
                  {revealedToken}
                </code>
                <Button variant="secondary" onClick={() => void copy(revealedToken, 'token')} className="shrink-0">
                  {copied === 'token' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
              <p className="text-xs text-success/80">{t('mcp.tokenOnce')}</p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="secondary" loading={generating} onClick={() => void generateToken()}>
                {!generating && <Key className="w-3.5 h-3.5 mr-1.5" />}
                {t('mcp.generateToken')}
              </Button>
              <span className="text-xs text-muted-foreground/70">{t('mcp.manageHint')}</span>
            </div>
          )}
        </div>

        {/* 能力清单 */}
        {sortedTools.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {t('mcp.toolsLabel', { n: sortedTools.length })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sortedTools.map((tool) => (
                <Tooltip key={tool.name} label={tool.description || tool.name}>
                  <span className="px-2 py-1 rounded-md border border-border/60 bg-muted/40 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-border transition-colors cursor-default">
                    {tool.name}
                  </span>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
