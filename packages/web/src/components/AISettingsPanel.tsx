import { useState, useEffect, useCallback } from 'react'
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
  FileSearch,
  Copy,
  ExternalLink,
} from 'lucide-react'
import {
  PRESETS,
  PRESETS_BY_REGION,
  REGION_LABELS,
  REGION_ORDER,
  KNOWN_EMBEDDING_MODELS,
  KNOWN_CHAT_MODELS,
  KEY_MASK,
  definitionFromPreset,
  defaultAutoLinkConfig,
  type ProviderDefinition,
  type ProviderPresetId,
  type AutoLinkConfig,
  type RerankerDefinition,
  type Region,
} from '@notefast/core'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'

interface AIStatus {
  enabled: boolean
  embedding: { configured: boolean; ok: boolean; dim?: number; lastError?: string }
  chat: { configured: boolean; ok: boolean; model?: string; lastError?: string }
  reranker: { configured: boolean; ok: boolean; model?: string; lastError?: string }
  autoLink: { configured: boolean; enabled: boolean; autoApply: 'never' | 'high_confidence'; lastError?: string }
  usage: {
    embeddingCalls: number
    chatCalls: number
    rerankCalls: number
    autoLinkAnalyses: number
    lastSuccessAt?: string
  }
  config: { chat: ProviderDefinition | null; embedding: ProviderDefinition | null; reranker: RerankerDefinition | null; autoLink?: AutoLinkConfig }
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
    autoApply: 'never' | 'high_confidence'
    ok: boolean
    prerequisites: {
      chat: { configured: boolean; ok: boolean }
      embedding: { configured: boolean; ok: boolean } | null
    }
  }
  elapsedMs: number
  ts: string
}

function defaultAutoLink(): AutoLinkConfig {
  return defaultAutoLinkConfig()
}

/** 根据浏览器 locale 推测一个合理的默认 preset；用户可在下拉中覆盖 */
function defaultPresetForLocale(): ProviderPresetId {
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || '').toLowerCase()
    if (lang.startsWith('zh')) return 'siliconflow'
  }
  return 'openrouter'
}

/** Field-level error map: 每个 ProviderDefinition 字段都可有错误 */
type FieldErrors = Partial<Record<keyof ProviderDefinition | 'global', string>>
type RerankerFieldErrors = Partial<Record<keyof RerankerDefinition | 'global', string>>

interface FormErrors {
  chat?: FieldErrors
  embedding?: FieldErrors
  reranker?: RerankerFieldErrors
}

/**
 * 把 validateConfig 返回的字符串错误按前缀切分到具体字段
 *  "Chat provider 必须填写 chatModel" → chat.chatModel
 *  "Chat provider baseUrl 不能为空" → chat.baseUrl
 *  "Embedding provider 必须填写 embeddingModel" → embedding.embeddingModel
 *  "Embedding provider baseUrl 不能为空" → embedding.baseUrl
 *  "Reranker baseUrl 不能为空" → reranker.baseUrl
 *  "Reranker model 不能为空" → reranker.model
 *  "AutoLink ..." → global（不属于上面三类）
 */
function errorsToFields(errors: string[]): FormErrors {
  const out: FormErrors = {}
  const fallback: string[] = []
  for (const e of errors) {
    if (e.startsWith('Chat provider 必须填写 chatModel') || e.includes('Chat provider chatModel')) {
      ;(out.chat ??= {}).chatModel = e
    } else if (e.includes('Chat provider baseUrl') || e === 'Chat provider baseUrl 不能为空') {
      ;(out.chat ??= {}).baseUrl = e
    } else if (e.includes('Chat provider timeout')) {
      ;(out.chat ??= {}).timeoutMs = e
    } else if (e.startsWith('Embedding provider') && e.includes('embeddingModel')) {
      ;(out.embedding ??= {}).embeddingModel = e
    } else if (e.startsWith('Embedding provider') && e.includes('baseUrl')) {
      ;(out.embedding ??= {}).baseUrl = e
    } else if (e.startsWith('Embedding provider') && e.includes('timeout')) {
      ;(out.embedding ??= {}).timeoutMs = e
    } else if (e.startsWith('Reranker') && e.includes('baseUrl')) {
      ;(out.reranker ??= {}).baseUrl = e
    } else if (e.startsWith('Reranker') && e.includes('model')) {
      ;(out.reranker ??= {}).model = e
    } else if (e.startsWith('Reranker') && e.includes('timeout')) {
      ;(out.reranker ??= {}).timeoutMs = e
    } else {
      fallback.push(e)
    }
  }
  if (fallback.length > 0) {
    out.chat ??= {}
    out.chat.global = fallback.join('；')
  }
  return out
}

/** 客户端快速校验（基于本地状态，避免不必要的网络往返） */
function localValidate(c: {
  chat: ProviderDefinition | null
  embedding: ProviderDefinition | null
  reranker: RerankerDefinition | null
}): string[] {
  const errs: string[] = []
  if (c.chat) {
    if (!c.chat.baseUrl.trim()) errs.push('Chat provider baseUrl 不能为空')
    if (!c.chat.chatModel.trim()) errs.push('Chat provider 必须填写 chatModel')
    if (c.chat.timeoutMs < 1000 || c.chat.timeoutMs > 600_000) {
      errs.push('Chat provider timeoutMs 应在 1000-600000 之间')
    }
  }
  if (c.embedding) {
    if (!c.embedding.baseUrl.trim()) errs.push('Embedding provider baseUrl 不能为空')
    if (!c.embedding.embeddingModel.trim()) {
      errs.push('Embedding provider 必须填写 embeddingModel')
    }
    if (c.embedding.timeoutMs < 1000 || c.embedding.timeoutMs > 600_000) {
      errs.push('Embedding provider timeoutMs 应在 1000-600000 之间')
    }
  }
  return errs
}

/** 简略描述 Provider 配置（用于保存后的 toast） */
function describeSaved(
  chat: ProviderDefinition | null,
  embedding: ProviderDefinition | null,
  reranker: RerankerDefinition | null
): string {
  const bits: string[] = []
  if (chat) bits.push(`Chat @ ${chat.baseUrl.replace(/^https?:\/\//, '')}`)
  if (embedding) bits.push(`Embedding @ ${embedding.baseUrl.replace(/^https?:\/\//, '')}`)
  if (reranker?.enabled) bits.push(`Reranker @ ${reranker.baseUrl.replace(/^https?:\/\//, '')}`)
  return bits.length > 0 ? bits.join(' · ') : '已清空所有 Provider'
}

export default function AISettingsPanel() {
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [chat, setChat] = useState<ProviderDefinition | null>(null)
  const [embedding, setEmbedding] = useState<ProviderDefinition | null>(null)
  const [autoIndex, setAutoIndex] = useState(true)
  const [reranker, setReranker] = useState<RerankerDefinition | null>(null)
  const [autoLink, setAutoLink] = useState<AutoLinkConfig>(defaultAutoLink())

  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null)
  const toast = useToast()
  // 字段级错误（红色内嵌到表单）+ 保存成功的最近一次描述（持久化显示在按钮旁）
  const [formErrors, setFormErrors] = useState<FormErrors>({})

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        api.get<AIStatus>('/ai/status'),
        api.get<Capabilities>('/ai/capabilities'),
      ])
      setStatus(s)
      setCapabilities(c)
      setChat(s.config.chat ?? null)
      setEmbedding(s.config.embedding ?? null)
      setReranker(s.config.reranker ?? null)
      setAutoLink(s.config.autoLink ?? defaultAutoLink())
    } catch (e) {
      toast.error({ title: '加载 AI 状态失败', description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSave = async () => {
    setFormErrors({})

    // 1) 客户端先校验 → 即时反馈
    const localErrs = localValidate({ chat, embedding, reranker })
    if (localErrs.length > 0) {
      setFormErrors(errorsToFields(localErrs))
      const first = localErrs[0]!
      toast.error({
        title: `表单校验失败（${localErrs.length} 项）`,
        description: `${first}${localErrs.length > 1 ? `……还有 ${localErrs.length - 1} 项，见下方红字` : ''}`,
        durationMs: 5500,
      })
      return
    }

    // 2) 真正落盘
    setSaving(true)
    try {
      const r = await api.put<{ ok: boolean; status: AIStatus }>('/ai/config', {
        chat,
        embedding,
        autoIndex,
        reranker: reranker?.enabled ? reranker : null,
        autoLink,
      })
      setStatus(r.status)
      toast.success({
        title: '配置已保存并热重载',
        description: describeSaved(chat, embedding, reranker),
      })
      refresh()
    } catch (e: unknown) {
      // 尝试从服务端 400 提取 errors[]
      const anyErr = e as { errors?: string[]; message?: string }
      const list = Array.isArray(anyErr?.errors) ? anyErr.errors : []
      if (list.length > 0) {
        setFormErrors(errorsToFields(list))
        toast.error({
          title: `服务端校验失败（${list.length} 项）`,
          description: `${list[0]}${list.length > 1 ? `……还有 ${list.length - 1} 项，见下方红字` : ''}`,
          durationMs: 6000,
        })
      } else {
        toast.error({
          title: '保存失败',
          description: anyErr?.message || (e instanceof Error ? e.message : String(e)),
          durationMs: 6000,
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    if (!confirm('禁用 AI 会清空所有 Chat / Embedding / Reranker 配置。继续？')) return
    try {
      await toast.promise(
        async () => {
          await api.put('/ai/config', {
            chat: null,
            embedding: null,
            autoIndex: false,
            reranker: null,
            autoLink: defaultAutoLink(),
          })
          await refresh()
        },
        {
          loading: '正在禁用 AI…',
          success: 'AI 已禁用',
          error: (e) => ({
            title: '禁用失败',
            description: e instanceof Error ? e.message : String(e),
          }),
        },
      )
    } catch {
      // toast 已弹
    }
  }

  const handleDiagnose = async () => {
    setTesting(true)
    try {
      const r = await api.post<DiagnoseResult>('/ai/diagnose', {})
      setDiagnose(r)
    } catch (e) {
      toast.error({
        title: '诊断失败',
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setTesting(false)
    }
  }

  const handleEnableChat = () => setChat(definitionFromPreset(defaultPresetForLocale()))
  const handleEnableEmbedding = () => setEmbedding(definitionFromPreset('siliconflow'))

  /**
   * 「复用 Chat」：把 Chat provider 的 baseUrl / apiKey / headers / preset 都拷到 Embedding，
   * 但只保留 embeddingModel 字段（清空 chatModel）。场景：
   * - 用 OpenAI 同时跑 gpt-5-mini 和 text-embedding-3-small
   * - 用 SiliconFlow 同一 Key 跑 DeepSeek-V4-Flash + Qwen3-Embedding-8B
   */
  const handleCopyChatToEmbedding = () => {
    if (!chat) return
    setEmbedding({
      ...chat,
      id: crypto.randomUUID(),
      label: `${chat.label} (Embedding)`,
      chatModel: '', // embedding provider 不需要 chatModel
      // 保留 embeddingModel：若 Chat provider 已有 embeddingModel 就一并用，否则清空让用户填
    })
  }

  return (
    <div className="space-y-5">
      {/* Top status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-border bg-background/40">
        <div className="flex items-center gap-2 text-sm">
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

      {/* Section 1: Chat Provider */}
      <Section
        icon={<Sparkles className="w-4 h-4" />}
        title="Chat Provider"
        hint="标题/摘要/对话/AutoLink 实体抽取都依赖 Chat；可选 DeepSeek / OpenAI / 智谱 / SiliconFlow 等任意 OpenAI 兼容服务"
      >
        {!chat && (
          <button
            type="button"
            onClick={handleEnableChat}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + 启用 Chat Provider
          </button>
        )}
        {chat && (
          <ProviderForm
            value={chat}
            onChange={setChat}
            mode="chat"
            onRemove={() => setChat(null)}
            keyShown={showKey}
            onToggleKey={() => setShowKey((s) => !s)}
            knownModels={KNOWN_CHAT_MODELS}
            modelLabel="Chat 模型"
            modelRequired={true}
            fieldErrors={formErrors.chat}
          />
        )}
      </Section>

      {/* Section 2: Embedding Provider (optional, independent) */}
      <Section
        icon={<FileSearch className="w-4 h-4" />}
        title="Embedding Provider"
        hint={
          <>
            语义搜索依赖 Embedding。可与 Chat 共用同一服务商（OpenAI / SiliconFlow 等），
            也可独立配 Voyage / Jina / Cohere 等专精 embedding 的服务。
            <span className="block mt-1 text-muted-foreground/80">
              留空 = 仅 FTS5 全文检索（仍可用，但失去「语义召回」能力）
            </span>
          </>
        }
      >
        {!embedding && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleEnableEmbedding}
              className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
            >
              + 启用 Embedding Provider
            </button>
            {chat && (
              <button
                type="button"
                onClick={handleCopyChatToEmbedding}
                className="w-full py-2 text-xs rounded-md border border-border text-muted-foreground hover:bg-accent inline-flex items-center justify-center gap-1.5"
              >
                <Copy className="w-3 h-3" />
                复用 Chat Provider 作为 Embedding（共用 baseUrl + apiKey）
              </button>
            )}
          </div>
        )}
        {embedding && (
          <div className="space-y-3">
            <ProviderForm
              value={embedding}
              onChange={setEmbedding}
              mode="embedding"
              onRemove={() => setEmbedding(null)}
              keyShown={showKey}
              onToggleKey={() => setShowKey((s) => !s)}
              knownModels={KNOWN_EMBEDDING_MODELS}
              modelLabel="Embedding 模型"
              modelRequired={true}
              fieldErrors={formErrors.embedding}
            />
            <button
              type="button"
              onClick={() => setEmbedding(null)}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              移除 Embedding（回到纯 FTS5 检索）
            </button>
          </div>
        )}
      </Section>

      {/* Section 3: Auto-index */}
      <Section
        icon={<Database className="w-4 h-4" />}
        title="Auto-Index"
        hint="新建 / 更新 block 时自动生成 embedding，支持语义搜索"
      >
        <Toggle
          checked={autoIndex}
          onChange={setAutoIndex}
          disabled={!capabilities?.embedding}
          label={
            capabilities?.embedding
              ? autoIndex ? '开启' : '关闭'
              : '需先配 Embedding'
          }
        />
      </Section>

      {/* Section 4: Reranker */}
      <Section icon={<GitBranch className="w-4 h-4" />} title="Reranker（可选）" hint="基于本地 TEI 服务或云端 bge-reranker 的精排；在 Hybrid Search 召回后做交叉注意力二次排序">
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
                value={reranker.apiKey === KEY_MASK ? '' : reranker.apiKey}
                onChange={(e) => {
                  const v = e.target.value
                  setReranker({ ...reranker, apiKey: v === '' && reranker.apiKey === KEY_MASK ? KEY_MASK : v })
                }}
                placeholder={reranker.apiKey === KEY_MASK ? '已保存 Key（留空保持不变）' : '留空 = 无鉴权'}
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

      {/* Section 5: AutoLink */}
      <Section icon={<Link2 className="w-4 h-4" />} title="AutoLink（自动反向链接）" hint="新建 / 更新 block 时由 LLM 抽取实体并匹配现有笔记，建议建链">
        <Toggle
          checked={autoLink.enabled}
          onChange={(v) => setAutoLink({ ...autoLink, enabled: v })}
          disabled={!capabilities?.chat}
          label={
            capabilities?.chat
              ? autoLink.enabled ? '启用' : '禁用'
              : '需先配 Chat'
          }
        />
        {autoLink.enabled && (
          <div className="mt-3 space-y-3 pl-4 border-l-2 border-border/60">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1.5">自动应用策略</div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    className="mt-0.5"
                    checked={autoLink.autoApply === 'never'}
                    onChange={() => setAutoLink({ ...autoLink, autoApply: 'never' })}
                  />
                  <span>
                    <span className="font-medium">仅建议</span>
                    <span className="block text-xs text-muted-foreground">
                      AI 抽取实体进 Inbox，但不写 block_refs；用户接受后才落地。
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    className="mt-0.5"
                    checked={autoLink.autoApply === 'high_confidence'}
                    onChange={() => setAutoLink({ ...autoLink, autoApply: 'high_confidence' })}
                  />
                  <span>
                    <span className="font-medium">高置信自动应用</span>
                    <span className="block text-xs text-muted-foreground">
                      满足 minConfidence（默认 0.75）且 top-1 显著领先时自动写入，其余进 Inbox。
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                minConfidence
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  className="w-20 px-2 py-1 rounded border border-border bg-background text-sm"
                  value={autoLink.minConfidence}
                  onChange={(e) => setAutoLink({ ...autoLink, minConfidence: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label className="flex items-center gap-1.5">
                minMargin
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  className="w-20 px-2 py-1 rounded border border-border bg-background text-sm"
                  value={autoLink.minMargin}
                  onChange={(e) => setAutoLink({ ...autoLink, minMargin: parseFloat(e.target.value) || 0 })}
                />
              </label>
            </div>
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

      <div className="flex items-center gap-2 pt-2 flex-wrap">
        <ActionButton
          onAction={async () => {
            if (!chat && !embedding) return
            await handleSave()
          }}
          successToast={{ title: '配置已保存并热重载' }}
          errorToast={(e) => ({
            title: '保存失败',
            description: e instanceof Error ? e.message : String(e),
            durationMs: 6000,
          })}
          disabled={!chat && !embedding}
        >
          保存配置
        </ActionButton>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent"
        >
          <RefreshCw className="w-4 h-4" />
          刷新状态
        </button>
        {(chat || embedding) && (
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

// ───────────── Provider Form（Chat 和 Embedding 共用）─────────────

function ProviderForm({
  value,
  onChange,
  mode,
  onRemove,
  keyShown,
  onToggleKey,
  knownModels,
  modelLabel,
  modelRequired,
  fieldErrors,
}: {
  value: ProviderDefinition
  onChange: (v: ProviderDefinition) => void
  mode: 'chat' | 'embedding'
  onRemove: () => void
  keyShown: boolean
  onToggleKey: () => void
  knownModels: string[]
  modelLabel: string
  modelRequired: boolean
  fieldErrors?: FieldErrors
}) {
  const preset = PRESETS[value.preset]
  const errBaseUrl = fieldErrors?.baseUrl
  const errModel = mode === 'chat' ? fieldErrors?.chatModel : fieldErrors?.embeddingModel
  const errTimeout = fieldErrors?.timeoutMs
  const inputErrClass = 'border-destructive focus-visible:ring-destructive/30'
  const inputOkClass = 'border-border'

  const handlePresetChange = (newPreset: ProviderPresetId) => {
    const p = PRESETS[newPreset]
    if (value.preset === newPreset) {
      // 同 preset：只更新 baseUrl 之类的元数据，保留用户已填的 key/models
      onChange({
        ...value,
        preset: newPreset,
        baseUrl: p.baseUrl,
        extraHeaders: { ...p.extraHeaders },
      })
      return
    }
    // 换供应商：清空 key（避免把 A 的 Key 发给 B），但 baseUrl + 默认模型直接套用 preset
    onChange({
      ...value,
      preset: newPreset,
      baseUrl: p.baseUrl,
      embeddingModel: p.embeddingModel,
      chatModel: p.chatModel,
      extraHeaders: { ...p.extraHeaders },
      apiKey: '',
      label: p.label,
    })
  }

  return (
    <div className="space-y-3">
      <FieldRow label="预设">
        <div className="flex items-center gap-2 min-w-0">
          <select
            value={value.preset}
            onChange={(e) => handlePresetChange(e.target.value as ProviderPresetId)}
            className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-md border border-border bg-background truncate"
          >
            {REGION_ORDER.map((region) => (
              <optgroup key={region} label={REGION_LABELS[region as Region]}>
                {PRESETS_BY_REGION[region as Region].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.hint}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <RegionBadge region={preset.region} />
          {preset.signupUrl && preset.region !== 'local' && (
            <a
              href={preset.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="获取 API Key"
            >
              <ExternalLink className="w-3 h-3" />
              获取 Key
            </a>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">{preset.hint}</p>
      </FieldRow>
      <FieldRow label="API Key">
        <div className="flex items-center gap-2">
          <input
            type={keyShown ? 'text' : 'password'}
            value={value.apiKey === KEY_MASK ? '' : value.apiKey}
            onChange={(e) => {
              const v = e.target.value
              onChange({ ...value, apiKey: v === '' && value.apiKey === KEY_MASK ? KEY_MASK : v })
            }}
            placeholder={value.apiKey === KEY_MASK ? '已保存 Key（留空保持不变，输入新 Key 替换）' : 'sk-...'}
            className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
          />
          <button
            type="button"
            onClick={onToggleKey}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
          >
            {keyShown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </FieldRow>
      <FieldRow label="Base URL" error={errBaseUrl}>
        <input
          type="text"
          value={value.baseUrl}
          onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
          placeholder={mode === 'chat' ? 'https://api.openai.com/v1' : 'https://api.openai.com/v1'}
          aria-invalid={!!errBaseUrl}
          className={`w-full px-3 py-1.5 text-sm rounded-md border bg-background font-mono ${errBaseUrl ? inputErrClass : inputOkClass}`}
        />
      </FieldRow>
      <FieldRow label={modelLabel} error={errModel}>
        <input
          type="text"
          value={mode === 'chat' ? value.chatModel : value.embeddingModel}
          onChange={(e) =>
            onChange(
              mode === 'chat'
                ? { ...value, chatModel: e.target.value }
                : { ...value, embeddingModel: e.target.value },
            )
          }
          list={`known-${mode}-models`}
          placeholder={mode === 'chat' ? 'gpt-5-mini / deepseek-v4-flash / glm-5' : 'text-embedding-3-small / voyage-4-large / Qwen/Qwen3-Embedding-8B'}
          aria-invalid={!!errModel}
          className={`w-full px-3 py-1.5 text-sm rounded-md border bg-background font-mono ${errModel ? inputErrClass : inputOkClass}`}
        />
        <datalist id={`known-${mode}-models`}>
          {knownModels.map((m) => <option key={m} value={m} />)}
        </datalist>
        {modelRequired && (
          <p className="text-[10px] text-muted-foreground mt-1">
            {mode === 'chat'
              ? 'Chat 模型必填（用于对话 / 标题 / AutoLink）'
              : 'Embedding 模型必填（用于语义搜索）'}
          </p>
        )}
      </FieldRow>
      <FieldRow label="超时（毫秒）" error={errTimeout}>
        <input
          type="number"
          min={1000}
          max={600000}
          step={1000}
          value={value.timeoutMs}
          onChange={(e) => onChange({ ...value, timeoutMs: parseInt(e.target.value, 10) || 60000 })}
          aria-invalid={!!errTimeout}
          className={`w-40 px-3 py-1.5 text-sm rounded-md border bg-background font-mono ${errTimeout ? inputErrClass : inputOkClass}`}
        />
      </FieldRow>
      <FieldRow label="额外 Header（OpenRouter 等需要 HTTP-Referer）">
        <ExtraHeadersEditor
          entries={Object.entries(value.extraHeaders)}
          onChange={(entries) => onChange({ ...value, extraHeaders: Object.fromEntries(entries) })}
        />
      </FieldRow>
      <FieldRow label="Provider 显示名">
        <input
          type="text"
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          placeholder={mode === 'chat' ? '我的 OpenRouter' : '我的 Voyage Embedding'}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
        />
      </FieldRow>
      <button
        type="button"
        onClick={onRemove}
        className="text-xs text-muted-foreground hover:text-destructive inline-flex items-center gap-1"
      >
        <X className="w-3 h-3" />
        移除{mode === 'chat' ? ' Chat Provider' : ' Embedding Provider'}
      </button>
    </div>
  )
}

function RegionBadge({ region }: { region: Region }) {
  const map: Record<Region, { tone: string; short: string }> = {
    cn: { tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', short: '国内' },
    global: { tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', short: '全球' },
    local: { tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', short: '本地' },
  }
  const v = map[region]
  return (
    <span className={`shrink-0 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded font-medium ${v.tone}`} title={REGION_LABELS[region]}>
      {v.short}
    </span>
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
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-3 border-b border-border bg-background/50">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          <span>{title}</span>
        </div>
        {hint && <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function FieldRow({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      <div className="mt-1">{children}</div>
      {error && (
        <div
          role="alert"
          className="mt-1 text-[11px] text-destructive flex items-start gap-1.5"
        >
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
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
  autoApply?: 'never' | 'high_confidence'
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
  if (!prereq.configured) return '需要 Chat 模型已配置'
  if (!prereq.ok) return '依赖 Chat 不可达，建议不会触发'
  return r.autoApply === 'high_confidence'
    ? '依赖 Chat 已通（高置信自动应用）'
    : '依赖 Chat 已通（仅建议）'
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
