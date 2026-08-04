import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from '../../i18n'
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
import { currentLocale } from '../../lib/time'
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

type EntityRebuildStatus = {
  running: boolean
  total: number
  done: number
  errors: number
  started_at: string | null
}

function defaultAutoLink(): AutoLinkConfig {
  return defaultAutoLinkConfig()
}

/**
 * 新增 chat / embedding / reranker 时的默认预设一律为「自定义」（空表单）——
 * 本地优先姿态：不替用户预选任何云端厂商，由用户显式选择。
 */

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
  return bits.length > 0 ? bits.join(' · ') : i18next.t('aiSettings.savedCleared')
}

export default function AISettingsPanel() {
  const { t } = useTranslation()
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
      toast.error({ title: t('aiSettings.loadStatusFailed'), description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast, t])

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

  // 实体重建进度轮询
  const [entityRebuild, setEntityRebuild] = useState<EntityRebuildStatus | null>(null)
  useEffect(() => {
    if (!entityRebuild?.running) return
    const t = setInterval(() => {
      void api
        .get<EntityRebuildStatus>('/ai/entities/rebuild/status')
        .then(setEntityRebuild)
        .catch(() => {})
    }, 800)
    return () => clearInterval(t)
  }, [entityRebuild?.running])

  const handleRebuildEntities = async () => {
    try {
      await api.post('/ai/entities/rebuild', {})
      toast.info({ title: t('aiSettings.entityRebuildStarted') })
      setEntityRebuild(await api.get<EntityRebuildStatus>('/ai/entities/rebuild/status'))
    } catch (e) {
      toast.error({
        title: t('aiSettings.entityRebuildFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleRebuild = async () => {
    if (rebuilding) return
    setRebuilding(true)
    try {
      await api.post('/ai/index/rebuild', {})
      toast.info({ title: t('aiSettings.rebuildStarted') })
      await refresh()
    } catch (e) {
      toast.error({
        title: t('aiSettings.rebuildFailed'),
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
        title: t('aiSettings.validationFailed', { n: localErrs.length }),
        description: `${first}${localErrs.length > 1 ? t('aiSettings.validationMore', { n: localErrs.length - 1 }) : ''}`,
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
        title: t('aiSettings.configSaved'),
        description: describeSaved(chat, embedding, reranker),
      })
      refresh()
    } catch (e: unknown) {
      // 服务端 400：ApiError.body 带 { error, message, errors[] }，拆成字段级红字
      const list = serverValidationErrors(e)
      if (list.length > 0) {
        setFormErrors(errorsToFields(list))
        toast.error({
          title: t('aiSettings.serverValidationFailed', { n: list.length }),
          description: `${list[0]}${list.length > 1 ? t('aiSettings.serverValidationMore', { n: list.length - 1 }) : ''}`,
          durationMs: 6000,
        })
      } else {
        toast.error({
          title: t('aiSettings.saveFailed'),
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
        title: t('aiSettings.diagnosisFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setTesting(false)
    }
  }

  const handleEnableChat = () => setChat(definitionFromPreset('custom'))
  const handleEnableEmbedding = () => setEmbedding(definitionFromPreset('custom'))

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
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs: 60000,
    preset: 'custom',
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
          <span className="font-medium">{t('aiSettings.aiCapabilities')}</span>
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
                  {t('aiSettings.lastSuccess', { time: new Date(status.usage.lastSuccessAt).toLocaleTimeString(currentLocale()) })}
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
            {t('aiSettings.oneClickDiagnose')}
          </button>
        </div>
      </div>

      {diagnose && (
        <DiagnosePanel result={diagnose} onClose={() => setDiagnose(null)} />
      )}

      {/* 分组：模型配置（Provider），功能卡均依赖这里的配置 */}
      <GroupLabel>{t('aiSettings.modelConfig')}</GroupLabel>

      {/* Section 1: 对话模型 */}
      <SettingsCard
        icon={<Sparkles className="w-4 h-4" />}
        title={t('aiSettings.chatModel')}
        helpTip={t('aiSettings.chatModelTip')}
        statusBadge={<StatusBadge active={!!chat && chat.enabled !== false} label={chat && chat.enabled === false ? t('aiSettings.disabled') : undefined} />}
      >
        {!chat && (
          <button
            type="button"
            onClick={handleEnableChat}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + {t('aiSettings.addChatModel')}
          </button>
        )}
        {chat && (
          <div className="space-y-4">
            <Toggle
              checked={chat.enabled !== false}
              onChange={(v) => setChat({ ...chat, enabled: v })}
              label={chat.enabled !== false ? t('aiSettings.enabled') : t('aiSettings.disabledRetainConfig')}
            />
            <ProviderForm
              value={chat}
              onChange={setChat}
              mode="chat"
              knownModels={KNOWN_CHAT_MODELS}
              modelLabel={t('aiSettings.chatModelLabel')}
              fieldErrors={formErrors.chat}
            />
          </div>
        )}
      </SettingsCard>

      {/* Section 2: 嵌入模型（可选，独立配置） */}
      <SettingsCard
        icon={<FileSearch className="w-4 h-4" />}
        title={t('aiSettings.embeddingModel')}
        helpTip={t('aiSettings.embeddingModelTip')}
        statusBadge={<StatusBadge active={!!embedding && embedding.enabled !== false} label={embedding && embedding.enabled === false ? t('aiSettings.disabled') : undefined} />}
      >
        {!embedding && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleEnableEmbedding}
              className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
            >
              + {t('aiSettings.addEmbeddingModel')}
            </button>
            {chat && (
              <button
                type="button"
                onClick={handleCopyChatToEmbedding}
                className="w-full py-2 text-xs rounded-md border border-border text-muted-foreground hover:bg-accent inline-flex items-center justify-center gap-1.5"
              >
                <Copy className="w-3 h-3" />
                {t('aiSettings.reuseChatConnection')}
              </button>
            )}
          </div>
        )}
        {embedding && (
          <div className="space-y-4">
            <Toggle
              checked={embedding.enabled !== false}
              onChange={(v) => setEmbedding({ ...embedding, enabled: v })}
              label={embedding.enabled !== false ? t('aiSettings.enabled') : t('aiSettings.disabledFallbackKeyword')}
            />
            <ProviderForm
              value={embedding}
              onChange={setEmbedding}
              mode="embedding"
              knownModels={KNOWN_EMBEDDING_MODELS}
              modelLabel={t('aiSettings.embeddingModelLabel')}
              fieldErrors={formErrors.embedding}
            />
          </div>
        )}
      </SettingsCard>

      {/* Section 3: 精排模型（Reranker，可选） */}
      <SettingsCard
        icon={<GitBranch className="w-4 h-4" />}
        title={t('aiSettings.rerankerModel')}
        helpTip={t('aiSettings.rerankerModelTip')}
        statusBadge={<StatusBadge active={!!reranker?.enabled} label={reranker && !reranker.enabled ? t('aiSettings.disabled') : undefined} />}
      >
        {!reranker && (
          <button
            type="button"
            onClick={handleEnableReranker}
            className="w-full py-3 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          >
            + {t('aiSettings.addRerankerModel')}
          </button>
        )}
        {reranker && rerankerAsProvider && (
          <div className="space-y-4">
            <Toggle
              checked={reranker.enabled}
              onChange={(v) => setReranker({ ...reranker, enabled: v })}
              label={reranker.enabled ? t('aiSettings.enabled') : t('aiSettings.disabledSkipRerank')}
            />
            <ProviderForm
              value={rerankerAsProvider}
              onChange={handleRerankerChange}
              mode="reranker"
              knownModels={['BAAI/bge-reranker-v2-m3', 'qwen3-rerank', 'jina-reranker-v3', 'voyage-rerank-2', 'voyage-rerank-2-lite']}
              modelLabel={t('aiSettings.rerankerModelLabel')}
            />
          </div>
        )}
      </SettingsCard>

      {/* 分组：功能（依赖上方模型配置） */}
      <GroupLabel>{t('aiSettings.feature')}</GroupLabel>

      {/* Section 4: 语义索引（自动索引 + 图片理解 + 向量库状态） */}
      <SettingsCard
        icon={<Database className="w-4 h-4" />}
        title={t('aiSettings.semanticIndex')}
        helpTip={t('aiSettings.semanticIndexTip')}
        statusBadge={<StatusBadge active={autoIndex} />}
      >
        <Toggle
          checked={autoIndex}
          onChange={setAutoIndex}
          disabled={!capabilities?.embedding}
          label={
            capabilities?.embedding
              ? autoIndex ? t('aiSettings.on') : t('aiSettings.off')
              : t('aiSettings.requiresEmbedding')
          }
        />
        <div className="mt-3 pt-3 border-t border-border/50">
          <Toggle
            checked={visionEnabled}
            onChange={setVisionEnabled}
            disabled={!capabilities?.chat}
            label={
              capabilities?.chat
                ? visionEnabled ? t('aiSettings.visionEnabled') : t('aiSettings.visionDisabled')
                : t('aiSettings.visionRequiresChat')
            }
          />
          <p className="mt-1.5 text-[12px] text-muted-foreground/80 leading-relaxed">
            {t('aiSettings.visionDescription')}
          </p>
        </div>
        {status?.vectorStore && (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 space-y-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-foreground">
                {status.vectorStore.status === 'ready' && t('aiSettings.vectorReady')}
                {status.vectorStore.status === 'stale' && t('aiSettings.vectorStale')}
                {status.vectorStore.status === 'rebuilding' && t('aiSettings.vectorRebuilding')}
                {status.vectorStore.status === 'failed' && t('aiSettings.vectorFailed')}
              </span>
              <span className="text-muted-foreground">
                {t('aiSettings.vectorCount', { n: status.vectorStore.count.toLocaleString(currentLocale()), backend: status.vectorStore.backend })}
              </span>
            </div>
            {status.vectorStore.status === 'stale' && (
              <p className="text-amber-700 dark:text-amber-400">
                {t('aiSettings.vectorStaleWarning')}
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
                  ? t('aiSettings.rebuildEta', { sec: (status.vectorStore.rebuild.eta_ms / 1000).toFixed(1) })
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
                {t('aiSettings.rebuildIndex')}
              </button>
              <button
                type="button"
                onClick={() => void handleRebuildEntities()}
                disabled={!capabilities?.chat || entityRebuild?.running === true}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-accent disabled:opacity-50"
              >
                {entityRebuild?.running && <Loader2 className="w-3 h-3 animate-spin" />}
                {t('aiSettings.rebuildEntities')}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="w-3 h-3" />
                {t('aiSettings.refresh')}
              </button>
            </div>
            {entityRebuild && entityRebuild.total > 0 && (
              <p className="tabular-nums text-muted-foreground">
                {t('aiSettings.entityRebuildProgress', {
                  done: entityRebuild.done,
                  total: entityRebuild.total,
                })}
                {entityRebuild.errors > 0 && t('aiSettings.entityRebuildErrors', { n: entityRebuild.errors })}
              </p>
            )}
          </div>
        )}
      </SettingsCard>

      {/* Section 5: AutoLink */}
      <SettingsCard
        icon={<Link2 className="w-4 h-4" />}
        title={t('aiSettings.autoLinkTitle')}
        helpTip={t('aiSettings.autoLinkTip')}
        statusBadge={<StatusBadge active={autoLink.enabled} />}
      >
        <Toggle
          checked={autoLink.enabled}
          onChange={(v) => setAutoLink({ ...autoLink, enabled: v })}
          disabled={!capabilities?.chat}
          label={
            capabilities?.chat
              ? autoLink.enabled ? t('aiSettings.enable') : t('aiSettings.disable')
              : t('aiSettings.requiresChat')
          }
        />
        {autoLink.enabled && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
              <InlineField
                label={t('aiSettings.minConfidence')}
                type="number"
                value={String(autoLink.minConfidence)}
                onChange={(v) => setAutoLink({ ...autoLink, minConfidence: parseFloat(v) || 0 })}
                mono
              />
              <InlineField
                label={t('aiSettings.minMargin')}
                type="number"
                value={String(autoLink.minMargin)}
                onChange={(v) => setAutoLink({ ...autoLink, minMargin: parseFloat(v) || 0 })}
                mono
              />
              <InlineField
                label={t('aiSettings.maxLinksPerBlock')}
                type="number"
                value={String(autoLink.maxPerBlock)}
                onChange={(v) => setAutoLink({ ...autoLink, maxPerBlock: Math.min(10, Math.max(1, parseInt(v, 10) || 5)) })}
                mono
              />
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Section 6: Web Search */}
      <SettingsCard
        icon={<Globe className="w-4 h-4" />}
        title={t('aiSettings.webSearch')}
        helpTip={t('aiSettings.webSearchTip')}
        statusBadge={<StatusBadge active={webSearchEnabled} />}
      >
        <Toggle
          checked={webSearchEnabled}
          onChange={setWebSearchEnabled}
          disabled={!capabilities?.chat}
          label={
            capabilities?.chat
              ? webSearchEnabled ? t('aiSettings.enable') : t('aiSettings.disable')
              : t('aiSettings.requiresChat')
          }
        />
        {webSearchEnabled && (
          <div className="mt-3 space-y-4 pt-2">
            <InlineField
              label="Brave Search API Key"
              description={t('aiSettings.keepUnchanged')}
              value={webSearchApiKey === KEY_MASK ? '' : webSearchApiKey}
              onChange={(v) => setWebSearchApiKey(v === '' && webSearchApiKey === KEY_MASK ? KEY_MASK : v)}
              placeholder={webSearchApiKey === KEY_MASK ? t('aiSettings.savedKey') : 'BSA-...'}
              type="password"
              mono
            />
            <p className="text-[12px] text-muted-foreground/80 leading-relaxed">
              {t('aiSettings.braveApiHint1')} <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">{t('aiSettings.braveApiKey')}</a>{t('aiSettings.braveApiHint2')}
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
          successToast={{ title: t('aiSettings.configSaved') }}
          errorToast={(e) => ({
            title: t('aiSettings.saveFailed'),
            description: e instanceof Error ? e.message : String(e),
            durationMs: 6000,
          })}
          disabled={!chat && !embedding}
        >
          {t('aiSettings.saveConfig')}
        </ActionButton>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent"
        >
          <RefreshCw className="w-4 h-4" />
          {t('aiSettings.refreshStatus')}
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
