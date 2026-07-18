import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Eye,
  EyeOff,
  Plus,
  X,
  Database,
  GitBranch,
  Link2,
  RefreshCw,
} from 'lucide-react'
import {
  PRESETS,
  KNOWN_EMBEDDING_MODELS,
  KNOWN_CHAT_MODELS,
  definitionFromPreset,
  type ProviderDefinition,
  type ProviderPresetId,
  type AutoLinkConfig,
  type RerankerDefinition,
} from '@notefast/core'
import { api } from '../hooks/useAPI'

interface AIStatus {
  enabled: boolean
  embedding: { configured: boolean; ok: boolean; dim?: number; lastError?: string }
  chat: { configured: boolean; ok: boolean; model?: string; lastError?: string }
  reranker: { configured: boolean; ok: boolean; model?: string; lastError?: string }
  autoLink: { configured: boolean; enabled: boolean; autoApply: boolean; lastError?: string }
  usage: {
    embeddingCalls: number
    chatCalls: number
    rerankCalls: number
    autoLinkAnalyses: number
    lastSuccessAt?: string
  }
  config: { active: ProviderDefinition | null; reranker: RerankerDefinition | null; autoLink?: AutoLinkConfig }
}

interface Capabilities {
  ai_enabled: boolean
  embedding: boolean
  chat: boolean
  reranker: boolean
  hybrid_search: boolean
}

interface DiagnoseResult {
  overall: 'healthy' | 'partial' | 'degraded' | 'idle'
  embedding: {
    configured: boolean
    ok: boolean
    latencyMs?: number
    dim?: number
    embeddingCalls?: number
    model?: string
    error?: string
    message?: string
  }
  chat: {
    configured: boolean
    ok: boolean
    latencyMs?: number
    model?: string
    replySample?: string
    error?: string
    message?: string
  }
  reranker: {
    configured: boolean
    ok: boolean
    latencyMs?: number
    model?: string
    hitCount?: number
    error?: string
    message?: string
  }
  autoLink: {
    configured: boolean
    enabled: boolean
    autoApply: boolean
    ok: boolean
    prerequisites: {
      chat: { configured: boolean; ok: boolean }
      embedding: { configured: boolean; ok: boolean } | null
    }
  }
  elapsedMs: number
  ts: string
}

function emptyProvider(presetId: ProviderPresetId = 'custom'): ProviderDefinition {
  return definitionFromPreset(presetId)
}

function defaultAutoLink(): AutoLinkConfig {
  return { enabled: false, autoApply: false, notebookScope: 'all', maxPerBlock: 5 }
}

export default function AISettingsPanel() {
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [active, setActive] = useState<ProviderDefinition | null>(null)
  const [autoIndex, setAutoIndex] = useState(true)
  const [reranker, setReranker] = useState<RerankerDefinition | null>(null)
  const [autoLink, setAutoLink] = useState<AutoLinkConfig>(defaultAutoLink())

  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [s, c] = await Promise.all([
        api.get<AIStatus>('/ai/status'),
        api.get<Capabilities>('/ai/capabilities'),
      ])
      setStatus(s)
      setCapabilities(c)
      setActive(s.config.active ?? null)
      setReranker(s.config.reranker ?? null)
      setAutoLink(s.config.autoLink ?? defaultAutoLink())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const preset = active?.preset ?? 'custom'

  const handlePresetChange = (newPreset: ProviderPresetId) => {
    const p = PRESETS[newPreset]
    if (!active) {
      setActive(definitionFromPreset(newPreset))
      return
    }
    setActive({
      ...active,
      preset: newPreset,
      baseUrl: p.baseUrl,
      embeddingModel: p.embeddingModel,
      chatModel: p.chatModel,
      extraHeaders: { ...p.extraHeaders },
    })
  }

  const updateActive = (patch: Partial<ProviderDefinition>) => {
    if (!active) {
      setActive({ ...emptyProvider(preset), ...patch })
    } else {
      setActive({ ...active, ...patch })
    }
  }

  const handleSave = async () => {
    if (!active) {
      setError('请先选择或填写 Provider')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const r = await api.put<{ ok: boolean; status: AIStatus }>('/ai/config', {
        active,
        autoIndex,
        reranker: reranker?.enabled ? reranker : null,
        autoLink,
      })
      setStatus(r.status)
      setSuccess('配置已保存并热重载')
      setTimeout(() => setSuccess(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    if (!confirm('禁用 AI 会清空所有配置。继续？')) return
    setSaving(true)
    try {
      await api.put('/ai/config', { active: null, autoIndex: false, reranker: null, autoLink: defaultAutoLink() })
      await refresh()
      setSuccess('已禁用')
      setTimeout(() => setSuccess(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDiagnose = async () => {
    setTesting(true)
    setError(null)
    try {
      const r = await api.post<DiagnoseResult>('/ai/diagnose', {})
      setDiagnose(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  const extraHeadersEntries = useMemo(() => {
    return Object.entries(active?.extraHeaders || {})
  }, [active?.extraHeaders])

  return (
    <div className="space-y-5">
      {/* Top status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-border bg-background/40">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="font-medium">AI 能力</span>
          {capabilities && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <CapabilityBadge ok={capabilities.chat} label="Chat" />
              <CapabilityBadge ok={capabilities.embedding} label="Embedding" />
              <CapabilityBadge ok={capabilities.reranker} label="Reranker" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status?.usage && (
            <div className="text-[10px] text-muted-foreground hidden md:flex gap-3">
              {status.usage.embeddingCalls > 0 && <span>emb: {status.usage.embeddingCalls}</span>}
              {status.usage.chatCalls > 0 && <span>chat: {status.usage.chatCalls}</span>}
              {status.usage.rerankCalls > 0 && <span>rerank: {status.usage.rerankCalls}</span>}
              {status.usage.autoLinkAnalyses > 0 && <span>link: {status.usage.autoLinkAnalyses}</span>}
              {status.usage.lastSuccessAt && (
                <span className="opacity-60">
                  上次 {new Date(status.usage.lastSuccessAt).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={handleDiagnose}
            disabled={testing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border bg-background hover:bg-accent disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            一键诊断
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {success}
        </div>
      )}
      {diagnose && (
        <div className="text-xs rounded-md bg-muted/40 border border-border overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background/40">
            <div className="flex items-center gap-2">
              <OverallDot overall={diagnose.overall} />
              <span className="font-medium text-foreground">
                {diagnose.overall === 'healthy'
                  ? '一切正常'
                  : diagnose.overall === 'partial'
                    ? '部分能力可用'
                    : diagnose.overall === 'degraded'
                      ? '已配置但都不可达'
                      : '尚未启用任何 AI 能力'}
              </span>
              {diagnose.elapsedMs != null && (
                <span className="text-[10px] text-muted-foreground/70 font-mono">
                  {diagnose.elapsedMs} ms
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDiagnose(null)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              关闭
            </button>
          </div>
          <div className="divide-y divide-border/60">
            <DiagRow icon="↻" label="Embedding" r={diagnose.embedding} />
            <DiagRow icon="✦" label="Chat" r={diagnose.chat} />
            <DiagRow icon="⊕" label="Reranker" r={diagnose.reranker} />
            {diagnose.autoLink.configured && (
              <DiagRow icon="⌘" label="AutoLink" r={diagnose.autoLink} autoLink />
            )}
          </div>
        </div>
      )}

      {/* Section 1: Active Provider */}
      <Section icon={<Sparkles className="w-4 h-4" />} title="Active Provider" hint="OpenAI 兼容；可填第三方 / 本地模型（Ollama / LM Studio / vLLM / 智谱…）">
        {!active && (
          <button
            type="button"
            onClick={() => setActive(emptyProvider('openai'))}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + 启用 AI Provider
          </button>
        )}
        {active && (
          <div className="space-y-3">
            <FieldRow label="预设">
              <select
                value={active.preset}
                onChange={(e) => handlePresetChange(e.target.value as ProviderPresetId)}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
              >
                {(Object.keys(PRESETS) as ProviderPresetId[]).map((k) => (
                  <option key={k} value={k}>
                    {PRESETS[k].label} — {PRESETS[k].hint}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="API Key">
              <div className="flex items-center gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={active.apiKey}
                  onChange={(e) => updateActive({ apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </FieldRow>
            <FieldRow label="Base URL">
              <input
                type="text"
                value={active.baseUrl}
                onChange={(e) => updateActive({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FieldRow label="Embedding 模型">
                <input
                  type="text"
                  value={active.embeddingModel}
                  onChange={(e) => updateActive({ embeddingModel: e.target.value })}
                  list="known-embedding-models"
                  placeholder="text-embedding-3-small"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                />
                <datalist id="known-embedding-models">
                  {KNOWN_EMBEDDING_MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
                <p className="text-[10px] text-muted-foreground mt-1">留空表示禁用 embedding</p>
              </FieldRow>
              <FieldRow label="Chat 模型">
                <input
                  type="text"
                  value={active.chatModel}
                  onChange={(e) => updateActive({ chatModel: e.target.value })}
                  list="known-chat-models"
                  placeholder="gpt-4o-mini"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                />
                <datalist id="known-chat-models">
                  {KNOWN_CHAT_MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
                <p className="text-[10px] text-muted-foreground mt-1">留空表示禁用 chat</p>
              </FieldRow>
            </div>
            <FieldRow label="超时（毫秒）">
              <input
                type="number"
                min={1000}
                max={600000}
                step={1000}
                value={active.timeoutMs}
                onChange={(e) => updateActive({ timeoutMs: parseInt(e.target.value, 10) || 60000 })}
                className="w-40 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <FieldRow label="额外 Header（OpenRouter 等需要 HTTP-Referer）">
              <ExtraHeadersEditor
                entries={extraHeadersEntries}
                onChange={(entries) => updateActive({ extraHeaders: Object.fromEntries(entries) })}
              />
            </FieldRow>
            <FieldRow label="Provider 显示名">
              <input
                type="text"
                value={active.label}
                onChange={(e) => updateActive({ label: e.target.value })}
                placeholder="我的 OpenRouter"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
              />
            </FieldRow>
          </div>
        )}
      </Section>

      {/* Section 2: Auto-index */}
      <Section
        icon={<Database className="w-4 h-4" />}
        title="Auto-Index"
        hint="新建 / 更新 block 时自动生成 embedding，支持语义搜索"
      >
        <Toggle
          checked={autoIndex}
          onChange={setAutoIndex}
          disabled={!capabilities?.embedding}
          label={autoIndex ? '开启' : '关闭'}
        />
        {!capabilities?.embedding && (
          <p className="text-[11px] text-muted-foreground mt-2">
            需要先配置 Embedding 模型。
          </p>
        )}
      </Section>

      {/* Section 3: Reranker */}
      <Section icon={<GitBranch className="w-4 h-4" />} title="Reranker（可选）" hint="基于本地 TEI 服务的精排；在 Hybrid Search 召回后做交叉注意力二次排序">
        {!reranker && (
          <button
            type="button"
            onClick={() => setReranker({ enabled: true, baseUrl: '', apiKey: '', model: '', timeoutMs: 30000 })}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + 添加 Reranker
          </button>
        )}
        {reranker && (
          <div className="space-y-3">
            <Toggle checked={reranker.enabled} onChange={(v) => setReranker({ ...reranker, enabled: v })} label={reranker.enabled ? '启用' : '禁用'} />
            <FieldRow label="Base URL（TEI /rerank 端点）">
              <input
                type="text"
                value={reranker.baseUrl}
                onChange={(e) => setReranker({ ...reranker, baseUrl: e.target.value })}
                placeholder="http://127.0.0.1:8080"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <FieldRow label="API Key（可选）">
              <input
                type="password"
                value={reranker.apiKey}
                onChange={(e) => setReranker({ ...reranker, apiKey: e.target.value })}
                placeholder="留空 = 无鉴权"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <FieldRow label="模型">
              <input
                type="text"
                value={reranker.model}
                onChange={(e) => setReranker({ ...reranker, model: e.target.value })}
                placeholder="BAAI/bge-reranker-v2-m3"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <FieldRow label="超时（毫秒）">
              <input
                type="number"
                min={1000}
                max={600000}
                step={1000}
                value={reranker.timeoutMs}
                onChange={(e) => setReranker({ ...reranker, timeoutMs: parseInt(e.target.value, 10) || 30000 })}
                className="w-40 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
            <button
              type="button"
              onClick={() => setReranker(null)}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              移除 Reranker
            </button>
          </div>
        )}
      </Section>

      {/* Section 4: AutoLink */}
      <Section icon={<Link2 className="w-4 h-4" />} title="AutoLink（自动反向链接）" hint="新建 / 更新 block 时由 LLM 抽取实体并匹配现有笔记，建议建链">
        <Toggle
          checked={autoLink.enabled}
          onChange={(v) => setAutoLink({ ...autoLink, enabled: v })}
          disabled={!capabilities?.chat}
          label={autoLink.enabled ? '启用' : '禁用'}
        />
        {!capabilities?.chat && (
          <p className="text-[11px] text-muted-foreground mt-2">
            需要先配置 Chat 模型。
          </p>
        )}
        {autoLink.enabled && (
          <div className="mt-3 space-y-3 pl-4 border-l-2 border-border/60">
            <Toggle
              checked={autoLink.autoApply}
              onChange={(v) => setAutoLink({ ...autoLink, autoApply: v })}
              label={autoLink.autoApply ? '自动应用（无提示）' : 'Suggest-first（用户在面板里确认）'}
            />
            <FieldRow label="Notebook 范围">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    checked={autoLink.notebookScope === 'all'}
                    onChange={() => setAutoLink({ ...autoLink, notebookScope: 'all' })}
                  />
                  全部
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    checked={autoLink.notebookScope === 'same'}
                    onChange={() => setAutoLink({ ...autoLink, notebookScope: 'same' })}
                  />
                  仅同 Notebook
                </label>
              </div>
            </FieldRow>
            <FieldRow label="每块最大建议数">
              <input
                type="number"
                min={1}
                max={10}
                value={autoLink.maxPerBlock}
                onChange={(e) => setAutoLink({ ...autoLink, maxPerBlock: Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 5)) })}
                className="w-24 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
              />
            </FieldRow>
          </div>
        )}
      </Section>

      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !active}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          保存
        </button>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent"
        >
          <RefreshCw className="w-4 h-4" />
          刷新状态
        </button>
        {active && (
          <button
            type="button"
            onClick={handleDisable}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-destructive hover:bg-destructive/10 ml-auto"
          >
            禁用 AI
          </button>
        )}
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-3 border-b border-border bg-background/50">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          <span>{title}</span>
        </div>
        {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-muted'
        } ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  )
}

function CapabilityBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${
        ok ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
      />
      {label}
    </span>
  )
}

type DiagR = {
  configured: boolean
  ok?: boolean
  latencyMs?: number
  message?: string
  error?: string
  dim?: number
  hitCount?: number
  replySample?: string
  model?: string
  embeddingCalls?: number
  prerequisites?: { chat: { configured: boolean; ok: boolean }; embedding: unknown }
  autoApply?: boolean
}

function OverallDot({ overall }: { overall: 'healthy' | 'partial' | 'degraded' | 'idle' }) {
  const tone =
    overall === 'healthy'
      ? 'bg-emerald-500'
      : overall === 'partial'
        ? 'bg-amber-500'
        : overall === 'degraded'
          ? 'bg-destructive'
          : 'bg-border'
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${tone}`} aria-label={overall} />
  )
}

function DiagRow({
  icon,
  label,
  r,
  autoLink,
}: {
  icon: string
  label: string
  r: DiagR
  autoLink?: boolean
}) {
  if (!r.configured) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 text-muted-foreground/70">
        <span className="w-5 text-center text-foreground/60 text-[13px]">{icon}</span>
        <span className="w-16 font-medium text-foreground/80">{label}</span>
        <span className="text-[11px] italic">未配置</span>
      </div>
    )
  }

  const ok = r.ok === true
  const detail = autoLink
    ? autoLinkFormat(r)
    : r.error
      ? `× ${truncateError(r.error)}`
      : r.message
        ? r.message
        : ''
  const meta = describeMeta(r)

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-5 text-center text-foreground/60 text-[13px]">{icon}</span>
      <span className="w-16 font-medium text-foreground">{label}</span>
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
      )}
      <span className={`flex-1 truncate ${ok ? 'text-foreground/85' : 'text-destructive'}`}>
        {detail}
      </span>
      <span className="text-[10px] text-muted-foreground/65 font-mono shrink-0">{meta}</span>
    </div>
  )
}

function autoLinkFormat(r: DiagR): string {
  const prereq = r.prerequisites?.chat
  if (!prereq) return ''
  return prereq.configured
    ? prereq.ok
      ? `依赖 Chat 已通${r.autoApply ? '（自动应用）' : '（suggest-first）'}`
      : '依赖 Chat 不可达，建议不会触发'
    : '需要 Chat 模型已配置'
}

function describeMeta(r: DiagR): string {
  const parts: string[] = []
  if (r.latencyMs != null) parts.push(`${r.latencyMs} ms`)
  if (r.dim != null) parts.push(`dim=${r.dim}`)
  if (r.hitCount != null) parts.push(`${r.hitCount} hits`)
  return parts.join(' · ')
}

function truncateError(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function ExtraHeadersEditor({
  entries,
  onChange,
}: {
  entries: [string, string][]
  onChange: (entries: [string, string][]) => void
}) {
  const update = (idx: number, patch: Partial<[string, string]>) => {
    const next = [...entries]
    const cur = next[idx]!
    next[idx] = [patch[0] ?? cur[0], patch[1] ?? cur[1]] as [string, string]
    onChange(next)
  }
  const remove = (idx: number) => {
    onChange(entries.filter((_, i) => i !== idx))
  }
  const add = () => onChange([...entries, ['', '']])
  return (
    <div className="space-y-2">
      {entries.map(([k, v], idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="text"
            value={k}
            onChange={(e) => update(idx, [e.target.value, v])}
            placeholder="Header-Name"
            className="flex-1 px-2 py-1 text-xs rounded-md border border-border bg-background font-mono"
          />
          <input
            type="text"
            value={v}
            onChange={(e) => update(idx, [k, e.target.value])}
            placeholder="value"
            className="flex-1 px-2 py-1 text-xs rounded-md border border-border bg-background font-mono"
          />
          <button type="button" onClick={() => remove(idx)} className="p-1 text-muted-foreground hover:text-destructive">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="w-3 h-3" />
        添加 Header
      </button>
    </div>
  )
}
