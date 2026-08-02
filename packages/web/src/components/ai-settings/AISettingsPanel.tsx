import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  Sparkles,
  Database,
  GitBranch,
  Link2,
  RefreshCw,
  FileSearch,
  Copy,
  Globe,
} from 'lucide-react'
import {
  KNOWN_EMBEDDING_MODELS,
  KNOWN_CHAT_MODELS,
  KEY_MASK,
  definitionFromPreset,
  defaultAutoLinkConfig,
  type AiDiagnoseResult,
  type ProviderDefinition,
  type ProviderPresetId,
  type AutoLinkConfig,
  type RerankerDefinition,
  type RuntimeStatus,
  type Capabilities,
} from '@notefast/core'
import { api } from '../../hooks/useAPI'
import { ActionButton, useToast, Toggle } from '../ui'
import { ProviderForm } from './ProviderForm'
import { DiagnosePanel } from './DiagnosePanel'
import { SettingsCard, InlineField, StatusBadge } from '../settings/ui'
import { CapabilityBadge } from './primitives'
import { errorsToFields, localValidate, serverValidationErrors, type FormErrors } from './validation'

/**
 * /ai/status 响应 = core RuntimeStatus + 服务端附加字段。
 */
type VectorStoreStatus = {
  backend: string
  status: 'ready' | 'stale' | 'rebuilding' | 'failed'
  modelFingerprint: string | null
  dimension: number | null
  count: number
  activeGeneration: string | null
  stagingGeneration: string | null
  error: string | null
  rebuild?: {
    processed: number
    total: number
    started_at: string
    elapsed_ms: number
    eta_ms: number | null
  }
}

type AIStatus = RuntimeStatus & {
  vectorStore?: VectorStoreStatus
  fix_hint?: string
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
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [webSearchApiKey, setWebSearchApiKey] = useState('')
  const [visionEnabled, setVisionEnabled] = useState(false)

  const [, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [diagnose, setDiagnose] = useState<AiDiagnoseResult | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
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
      setAutoIndex(s.config.autoIndex ?? true)
      setWebSearchEnabled(s.config.webSearch?.enabled ?? false)
      setWebSearchApiKey(s.config.webSearch?.apiKey ?? '')
      setVisionEnabled(s.config.vision?.enabled ?? false)
    } catch (e) {
      toast.error({ title: '加载 AI 状态失败', description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 重建中轮询 index/status
  useEffect(() => {
    const vs = status?.vectorStore
    if (!vs || vs.status !== 'rebuilding') return
    const t = setInterval(() => {
      void refresh()
    }, 800)
    return () => clearInterval(t)
  }, [status?.vectorStore?.status, refresh])

  const handleRebuild = async () => {
    if (rebuilding) return
    setRebuilding(true)
    try {
      await api.post('/ai/index/rebuild', {})
      toast.info({ title: '已开始重建向量索引' })
      await refresh()
    } catch (e) {
      toast.error({
        title: '重建失败',
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRebuilding(false)
    }
  }

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
        webSearch: webSearchEnabled ? { enabled: true, apiKey: webSearchApiKey } : undefined,
        vision: visionEnabled ? { enabled: true } : undefined,
      })
      setStatus(r.status)
      toast.success({
        title: '配置已保存并热重载',
        description: describeSaved(chat, embedding, reranker),
      })
      refresh()
    } catch (e: unknown) {
      // 服务端 400：ApiError.body 带 { error, message, errors[] }，拆成字段级红字
      const list = serverValidationErrors(e)
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
          description: e instanceof Error ? e.message : String(e),
          durationMs: 6000,
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDiagnose = async () => {
    setTesting(true)
    try {
      const r = await api.post<AiDiagnoseResult>('/ai/diagnose', {})
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
      chatModel: '',
    })
  }

  const handleEnableReranker = () => setReranker({
    enabled: true,
    baseUrl: 'https://api.jina.ai/v1',
    apiKey: '',
    model: 'jina-reranker-v3',
    timeoutMs: 60000,
    preset: 'jina',
  })

  const rerankerAsProvider: ProviderDefinition | null = reranker ? {
    id: 'reranker',
    label: 'Reranker',
    preset: (reranker.preset as ProviderPresetId) || 'custom',
    baseUrl: reranker.baseUrl,
    apiKey: reranker.apiKey,
    embeddingModel: reranker.model,
    chatModel: '',
    timeoutMs: reranker.timeoutMs,
    extraHeaders: {},
  } : null

  const handleRerankerChange = (v: ProviderDefinition) => {
    setReranker({
      enabled: reranker?.enabled ?? true,
      baseUrl: v.baseUrl,
      apiKey: v.apiKey,
      model: v.embeddingModel,
      timeoutMs: v.timeoutMs,
      preset: v.preset,
    })
  }

  return (
    <div className="space-y-5">
      {/* Top status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border bg-background/40">
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
        <DiagnosePanel result={diagnose} onClose={() => setDiagnose(null)} />
      )}

      {/* 分组：模型配置（Provider），功能卡均依赖这里的配置 */}
      <GroupLabel>模型配置</GroupLabel>

      {/* Section 1: 对话模型 */}
      <SettingsCard
        icon={<Sparkles className="w-4 h-4" />}
        title="对话模型"
        helpTip="标题生成、文档摘要、AI 聊天与 AutoLink 实体抽取都调用这个模型。"
        statusBadge={<StatusBadge active={!!chat && chat.enabled !== false} label={chat && chat.enabled === false ? '已停用' : undefined} />}
      >
        {!chat && (
          <button
            type="button"
            onClick={handleEnableChat}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + 添加对话模型
          </button>
        )}
        {chat && (
          <div className="space-y-4">
            <Toggle
              checked={chat.enabled !== false}
              onChange={(v) => setChat({ ...chat, enabled: v })}
              label={chat.enabled !== false ? '已启用' : '已停用（保留配置，不参与调用）'}
            />
            <ProviderForm
              value={chat}
              onChange={setChat}
              mode="chat"
              knownModels={KNOWN_CHAT_MODELS}
              modelLabel="对话模型"
              fieldErrors={formErrors.chat}
            />
          </div>
        )}
      </SettingsCard>

      {/* Section 2: 嵌入模型（可选，独立配置） */}
      <SettingsCard
        icon={<FileSearch className="w-4 h-4" />}
        title="嵌入模型"
        helpTip="把文本转为向量，支撑语义搜索（理解近似含义与同义词）。未配置时检索退化为纯关键词匹配。"
        statusBadge={<StatusBadge active={!!embedding && embedding.enabled !== false} label={embedding && embedding.enabled === false ? '已停用' : undefined} />}
      >
        {!embedding && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleEnableEmbedding}
              className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
            >
              + 添加嵌入模型
            </button>
            {chat && (
              <button
                type="button"
                onClick={handleCopyChatToEmbedding}
                className="w-full py-2 text-xs rounded-md border border-border text-muted-foreground hover:bg-accent inline-flex items-center justify-center gap-1.5"
              >
                <Copy className="w-3 h-3" />
                复用对话模型的连接（共用 baseUrl + apiKey）
              </button>
            )}
          </div>
        )}
        {embedding && (
          <div className="space-y-4">
            <Toggle
              checked={embedding.enabled !== false}
              onChange={(v) => setEmbedding({ ...embedding, enabled: v })}
              label={embedding.enabled !== false ? '已启用' : '已停用（保留配置，回退为纯关键词检索）'}
            />
            <ProviderForm
              value={embedding}
              onChange={setEmbedding}
              mode="embedding"
              knownModels={KNOWN_EMBEDDING_MODELS}
             modelLabel="嵌入模型"
            fieldErrors={formErrors.embedding}
          />
          </div>
        )}
      </SettingsCard>

      {/* Section 3: 精排模型（Reranker，可选） */}
      <SettingsCard
        icon={<GitBranch className="w-4 h-4" />}
        title="精排模型 (Reranker)"
        helpTip="对混合检索的召回结果做二次精准排序，让最相关的笔记排在前面。可选。"
        statusBadge={<StatusBadge active={!!reranker?.enabled} label={reranker && !reranker.enabled ? '已停用' : undefined} />}
      >
        {!reranker && (
          <button
            type="button"
            onClick={handleEnableReranker}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + 添加精排模型
          </button>
        )}
        {reranker && rerankerAsProvider && (
          <div className="space-y-4">
            <Toggle
              checked={reranker.enabled}
              onChange={(v) => setReranker({ ...reranker, enabled: v })}
              label={reranker.enabled ? '已启用' : '已停用（保留配置，检索跳过精排）'}
            />
            <ProviderForm
              value={rerankerAsProvider}
              onChange={handleRerankerChange}
              mode="reranker"
              knownModels={['BAAI/bge-reranker-v2-m3', 'jina-reranker-v3', 'voyage-rerank-2', 'voyage-rerank-2-lite']}
              modelLabel="重排模型"
            />
          </div>
        )}
      </SettingsCard>

      {/* 分组：功能（依赖上方模型配置） */}
      <GroupLabel>功能</GroupLabel>

      {/* Section 4: 语义索引（自动索引 + 图片理解 + 向量库状态） */}
      <SettingsCard
        icon={<Database className="w-4 h-4" />}
        title="语义索引"
        helpTip="写入或更新笔记时自动生成向量索引，是语义搜索的数据来源。含图片理解与向量库状态。"
        statusBadge={<StatusBadge active={autoIndex} />}
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
        <div className="mt-3 pt-3 border-t border-border/50">
          <Toggle
            checked={visionEnabled}
            onChange={setVisionEnabled}
            disabled={!capabilities?.chat}
            label={
              capabilities?.chat
                ? visionEnabled ? '图片理解 · 开启' : '图片理解 · 关闭'
                : '图片理解 · 需先配 Chat'
            }
          />
          <p className="mt-1.5 text-[12px] text-muted-foreground/80 leading-relaxed">
            开启后，索引时会为文档中的图片生成文字描述并纳入语义检索（每张图片会调用一次视觉模型，图片内容会发送给所配置的 AI 服务商）
          </p>
        </div>
        {status?.vectorStore && (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 space-y-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-foreground">
                {status.vectorStore.status === 'ready' && '就绪'}
                {status.vectorStore.status === 'stale' && '需重建'}
                {status.vectorStore.status === 'rebuilding' && '重建中'}
                {status.vectorStore.status === 'failed' && '失败'}
              </span>
              <span className="text-muted-foreground">
                · {status.vectorStore.count.toLocaleString()} 向量 · {status.vectorStore.backend}
              </span>
            </div>
            {status.vectorStore.status === 'stale' && (
              <p className="text-amber-700 dark:text-amber-400">
                模型已变 · 旧向量未参与检索 · 请重建
              </p>
            )}
            {status.vectorStore.error && status.vectorStore.status !== 'ready' && (
              <p className="text-destructive/90 break-words">{status.vectorStore.error}</p>
            )}
            {status.vectorStore.rebuild && (
              <p className="tabular-nums text-muted-foreground">
                {status.vectorStore.rebuild.processed}/{status.vectorStore.rebuild.total}
                {' · '}
                {(status.vectorStore.rebuild.elapsed_ms / 1000).toFixed(1)}s
                {status.vectorStore.rebuild.eta_ms != null && status.vectorStore.rebuild.eta_ms > 0
                  ? ` · 约 ${(status.vectorStore.rebuild.eta_ms / 1000).toFixed(1)}s`
                  : ''}
              </p>
            )}
            <div className="flex gap-2 pt-0.5">
              <button
                type="button"
                onClick={handleRebuild}
                disabled={!capabilities?.embedding || rebuilding || status.vectorStore.status === 'rebuilding'}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-accent disabled:opacity-50"
              >
                {(rebuilding || status.vectorStore.status === 'rebuilding') && (
                  <Loader2 className="w-3 h-3 animate-spin" />
                )}
                重建索引
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="w-3 h-3" />
                刷新
              </button>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Section 5: AutoLink */}
      <SettingsCard
        icon={<Link2 className="w-4 h-4" />}
        title="AutoLink 自动建链"
        helpTip="写入笔记后自动抽取关键概念，置信度达标即建立笔记间链接；不达标静默跳过，无需人工审核。"
        statusBadge={<StatusBadge active={autoLink.enabled} />}
      >
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
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
              <InlineField
                label="minConfidence"
                type="number"
                value={String(autoLink.minConfidence)}
                onChange={(v) => setAutoLink({ ...autoLink, minConfidence: parseFloat(v) || 0 })}
                mono
              />
              <InlineField
                label="minMargin"
                type="number"
                value={String(autoLink.minMargin)}
                onChange={(v) => setAutoLink({ ...autoLink, minMargin: parseFloat(v) || 0 })}
                mono
              />
              <InlineField
                label="每块最大建链数"
                type="number"
                value={String(autoLink.maxPerBlock)}
                onChange={(v) => setAutoLink({ ...autoLink, maxPerBlock: Math.min(10, Math.max(1, parseInt(v, 10) || 5)) })}
                mono
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <h4 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">Notebook 范围</h4>
              <div
                className="inline-flex items-center rounded-md border border-border/60 bg-muted/30 p-0.5 text-[12px]"
                role="group"
                aria-label="Notebook 范围"
              >
                <button
                  type="button"
                  aria-pressed={autoLink.notebookScope === 'all'}
                  onClick={() => setAutoLink({ ...autoLink, notebookScope: 'all' })}
                  className={`px-2.5 py-1 rounded-[5px] transition-colors ${
                    autoLink.notebookScope === 'all'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  全部
                </button>
                <button
                  type="button"
                  aria-pressed={autoLink.notebookScope === 'same'}
                  onClick={() => setAutoLink({ ...autoLink, notebookScope: 'same' })}
                  className={`px-2.5 py-1 rounded-[5px] transition-colors ${
                    autoLink.notebookScope === 'same'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  仅同 Notebook
                </button>
              </div>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Section 6: Web Search */}
      <SettingsCard
        icon={<Globe className="w-4 h-4" />}
        title="网页搜索"
        helpTip="知识库找不到答案时，AI 可联网用 Brave Search 补充信息；结果用 🌐 标注来源，与笔记引用 [n] 区分。"
        statusBadge={<StatusBadge active={webSearchEnabled} />}
      >
        <Toggle
          checked={webSearchEnabled}
          onChange={setWebSearchEnabled}
          disabled={!capabilities?.chat}
          label={
            capabilities?.chat
              ? webSearchEnabled ? '启用' : '禁用'
              : '需先配 Chat'
          }
        />
        {webSearchEnabled && (
          <div className="mt-3 space-y-4 pt-2">
            <InlineField
              label="Brave Search API Key"
              description="留空保持不变"
              value={webSearchApiKey === KEY_MASK ? '' : webSearchApiKey}
              onChange={(v) => setWebSearchApiKey(v === '' && webSearchApiKey === KEY_MASK ? KEY_MASK : v)}
              placeholder={webSearchApiKey === KEY_MASK ? '已保存 Key' : 'BSA-...'}
              type="password"
              mono
            />
            <p className="text-[12px] text-muted-foreground/80 leading-relaxed">
              需要 <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Brave Search API Key</a>（免费额度 1000 次/月）
            </p>
          </div>
        )}
      </SettingsCard>

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
      </div>
    </div>
  )
}

/** 分组小标题（模型配置 / 功能） */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70 select-none">
      {children}
    </h3>
  )
}
