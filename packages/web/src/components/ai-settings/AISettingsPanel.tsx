import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
  TriangleAlert,
  X,
} from 'lucide-react'
import {
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
import { ActionButton, useToast, Toggle, Tooltip } from '../ui'
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

/** 增量索引作业（zip 导入等后台向量化）汇总 */
type IndexJobSummary = {
  pending: number
  running: number
  ready: number
  failed: number
  active: {
    id: string
    doc_id: string
    total_blocks: number
    done: number
    skipped: number
    errors: number
    state: string
    started_at: string | null
    finished_at: string | null
    elapsed_ms: number
    eta_ms: number | null
    error: string | null
  } | null
  recent: Array<{
    id: string
    doc_id: string
    total_blocks: number
    done: number
    skipped: number
    errors: number
    state: string
    started_at: string | null
    finished_at: string | null
    elapsed_ms: number
    eta_ms: number | null
    error: string | null
  }>
  indexedBlocks: number
}

type AIStatus = RuntimeStatus & {
  vectorStore?: VectorStoreStatus
  indexJobs?: IndexJobSummary
  fix_hint?: string
}

type EntityRebuildStatus = {
  running: boolean
  total: number
  done: number
  errors: number
  started_at: string | null
  eta_ms: number | null
  last_error: string | null
  skipped?: number
  indexState?: {
    status: 'empty' | 'ready' | 'rebuilding' | 'failed'
    analyzedBlocks: number
    entityCount: number
    error: string | null
  }
}

function defaultAutoLink(): AutoLinkConfig {
  return defaultAutoLinkConfig()
}

/**
 * 新增 chat / embedding / reranker 时的默认预设一律为「自定义」（空表单）——
 * 本地优先姿态：不替用户预选任何云端厂商，由用户显式选择。
 */

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
  const [refreshing, setRefreshing] = useState(false)
  const [entityRebuild, setEntityRebuild] = useState<EntityRebuildStatus | null>(null)
  // 「未保存修改」检测：savedSnapshot 记录最近一次保存/刷新时的表单状态，
  // dirty = 当前表单与其不一致（任何配置项被改过）。保存成功后更新快照。
  const [savedSnapshot, setSavedSnapshot] = useState<string>('')
  const dirty = useMemo(() => {
    const cur = JSON.stringify({ chat, embedding, reranker, autoLink, autoIndex, webSearchEnabled, webSearchApiKey, visionEnabled })
    return savedSnapshot !== '' && cur !== savedSnapshot
  }, [chat, embedding, reranker, autoLink, autoIndex, webSearchEnabled, webSearchApiKey, visionEnabled, savedSnapshot])

  // 有未保存修改时：关窗/刷新弹原生确认（对齐 MarkdownEditor 模式）
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // 站内导航不拦截（兜底哲学：提示为主，不打断操作流）。
  // 关窗/刷新由上方 beforeunload 兜底；dirty 时保存栏高亮 + 提示已足够。
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
      setSavedSnapshot(
        JSON.stringify({
          chat: s.config.chat ?? null,
          embedding: s.config.embedding ?? null,
          reranker: s.config.reranker ?? null,
          autoLink: s.config.autoLink ?? defaultAutoLink(),
          autoIndex: s.config.autoIndex ?? true,
          webSearchEnabled: s.config.webSearch?.enabled ?? false,
          webSearchApiKey: s.config.webSearch?.apiKey ?? '',
          visionEnabled: s.config.vision?.enabled ?? false,
        }),
      )
    } catch (e) {
      toast.error({ title: t('aiSettings.loadStatusFailed'), description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast, t])

  /** 底部「刷新状态」：显式转圈反馈（自动轮询不走这里，避免闪烁） */
  const handleManualRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
      // 实体重建进度与 /ai/status 分轨，手动刷新时一并拉
      const er = await api.get<EntityRebuildStatus>('/ai/entities/rebuild/status').catch(() => null)
      if (er) setEntityRebuild(er)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    refresh()
    // 实体重建进度与 /ai/status 分轨：挂载时恢复（离开页面再回来，服务端仍在跑）
    api
      .get<EntityRebuildStatus>('/ai/entities/rebuild/status')
      .then((er) => setEntityRebuild(er))
      .catch(() => {})
  }, [refresh])

  // 重建中轮询 index/status（800ms）；增量索引作业进行中轮询（1.5s）
  useEffect(() => {
    const vs = status?.vectorStore
    const jobs = status?.indexJobs
    const busy = (vs?.status === 'rebuilding') || Boolean(jobs?.running || (jobs?.pending ?? 0) > 0)
    if (!busy) return
    const t = setInterval(() => {
      void refresh()
    }, vs?.status === 'rebuilding' ? 800 : 1500)
    return () => clearInterval(t)
  }, [status?.vectorStore?.status, status?.indexJobs?.running, status?.indexJobs?.pending, refresh])

  // 实体重建进度轮询
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
      // 已在重建：不报错，拉一次最新进度恢复展示（离开页面再回来时的场景）
      const msg = e instanceof Error ? e.message : String(e)
      const er = await api.get<EntityRebuildStatus>('/ai/entities/rebuild/status').catch(() => null)
      if (er?.running) {
        setEntityRebuild(er)
        toast.info({ title: t('aiSettings.entityRebuildInProgress'), description: t('aiSettings.entityRebuildResumed') })
      } else {
        toast.error({
          title: t('aiSettings.entityRebuildFailed'),
          description: msg,
        })
      }
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

  const handleCancelRebuild = async () => {
    try {
      await api.post('/ai/index/rebuild/cancel', {})
      toast.info({ title: t('aiSettings.cancelRebuildSent') })
      await refresh()
    } catch (e) {
      toast.error({
        title: t('aiSettings.cancelRebuildFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleCancelEntityRebuild = async () => {
    try {
      await api.post('/ai/entities/rebuild/cancel', {})
      toast.info({ title: t('aiSettings.cancelRebuildSent') })
      await refresh()
    } catch (e) {
      toast.error({
        title: t('aiSettings.cancelRebuildFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleSave = async () => {
    setFormErrors({})

    // 1) 客户端先校验 → 即时反馈（字段级红字 + 抛错让 ActionButton 的 errorToast 提示，
    //    避免「校验失败」与 ActionButton 的 successToast 同时弹出）
    const localErrs = localValidate({ chat, embedding, reranker })
    if (localErrs.length > 0) {
      setFormErrors(errorsToFields(localErrs))
      const first = localErrs[0]!
      throw new Error(
        `${t('aiSettings.validationFailed', { n: localErrs.length })}：${first}${localErrs.length > 1 ? t('aiSettings.validationMore', { n: localErrs.length - 1 }) : ''}`,
      )
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
        // 图片理解是自动索引的附加参数：自动索引关闭时忽略（避免孤立配置）
        vision: autoIndex && visionEnabled ? { enabled: true } : undefined,
      })
      setStatus(r.status)
      // 成功提示由调用方（ActionButton successToast）统一弹，这里不重复
      // 保存成功：本地立即更新快照（dirty 归 false），不等 refresh 回读
      setSavedSnapshot(
        JSON.stringify({
          chat,
          embedding,
          reranker,
          autoLink,
          autoIndex,
          webSearchEnabled,
          webSearchApiKey,
          visionEnabled,
        }),
      )
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
            <div className="flex items-center gap-1.5 text-2xs">
              <CapabilityBadge ok={capabilities.chat} label="Chat" />
              <CapabilityBadge ok={capabilities.embedding} label="Embedding" />
              <CapabilityBadge ok={capabilities.reranker} label="Reranker" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status?.usage?.lastSuccessAt && (
            <div className="text-2xs text-muted-foreground hidden md:block opacity-60">
              {t('aiSettings.lastSuccess', { time: new Date(status.usage.lastSuccessAt).toLocaleTimeString(currentLocale()) })}
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
        {/* 附加参数：自动索引的子选项（视觉次级化；自动索引关闭时禁用） */}
        <div className={`mt-3 pt-3 border-t border-border/50 ${autoIndex ? '' : 'opacity-60'}`}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70 mb-2">
            {t('aiSettings.additionalParams')}
          </p>
          <Toggle
            checked={visionEnabled}
            onChange={setVisionEnabled}
            disabled={!capabilities?.chat || !autoIndex}
            label={
              !autoIndex
                ? t('aiSettings.visionRequiresAutoIndex')
                : capabilities?.chat
                  ? t('aiSettings.visionTitle')
                  : t('aiSettings.visionRequiresChat')
            }
          />
          <p className="mt-1.5 text-sm text-muted-foreground/80 leading-relaxed">
            {t('aiSettings.visionDescription')}
          </p>
        </div>
        {status?.vectorStore && (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 space-y-2 text-sm">
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
              <p className="text-warning">
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
            {/* 增量索引作业（zip 导入 / 批量创建后的后台向量化）进度 */}
            {(() => {
              const jobs = status.indexJobs
              if (!jobs) return null
              const busy = jobs.running > 0 || jobs.pending > 0
              const active = jobs.active
              return (
                <div className="pt-1.5 border-t border-border/60 space-y-1.5">
                  {busy ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                      {active ? (
                        <span className="tabular-nums">
                          {t('aiSettings.indexJobActive', {
                            done: active.done + active.skipped,
                            total: active.total_blocks,
                            pending: jobs.pending,
                          })}
                        </span>
                      ) : (
                        <span>{t('aiSettings.indexJobQueued', { n: jobs.pending })}</span>
                      )}
                      {active && active.eta_ms != null && active.eta_ms > 0 && (
                        <span className="tabular-nums text-muted-foreground/70">
                          {t('aiSettings.indexJobEta', { sec: (active.eta_ms / 1000).toFixed(1) })}
                        </span>
                      )}
                    </div>
                  ) : jobs.ready + jobs.failed > 0 ? (
                    <p className="text-sm text-success">
                      {t('aiSettings.indexJobIdle', { ready: jobs.ready, failed: jobs.failed })}
                    </p>
                  ) : null}
                  {jobs.indexedBlocks > 0 && (
                    <p className="text-xs text-muted-foreground/60">
                      {t('aiSettings.indexJobBlocks', { n: jobs.indexedBlocks.toLocaleString(currentLocale()) })}
                    </p>
                  )}
                </div>
              )
            })()}
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
              {status.vectorStore.status === 'rebuilding' && (
                <button
                  type="button"
                  onClick={() => void handleCancelRebuild()}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  <X className="w-3 h-3" />
                  {t('aiSettings.cancelRebuild')}
                </button>
              )}
              <Tooltip label={t('aiSettings.entityRebuildCostHint')}>
                <button
                  type="button"
                  onClick={() => void handleRebuildEntities()}
                  disabled={!capabilities?.chat || entityRebuild?.running === true}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-accent disabled:opacity-50"
                >
                  {entityRebuild?.running && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t('aiSettings.rebuildEntities')}
                </button>
              </Tooltip>
              {entityRebuild?.running && (
                <button
                  type="button"
                  onClick={() => void handleCancelEntityRebuild()}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <X className="w-3 h-3" />
                  {t('aiSettings.cancelRebuild')}
                </button>
              )}
            </div>
            {entityRebuild?.indexState && !entityRebuild.running && (
              <p className="text-xs text-muted-foreground">
                {entityRebuild.indexState.status === 'empty' && (
                  <span className="inline-flex items-center gap-1.5 text-warning">
                    <TriangleAlert className="w-3.5 h-3.5" />
                    {t('aiSettings.entityIndexEmpty')}
                  </span>
                )}
                {entityRebuild.indexState.status === 'ready' && (
                  t('aiSettings.entityIndexReady', {
                    entities: entityRebuild.indexState.entityCount,
                    blocks: entityRebuild.indexState.analyzedBlocks,
                  })
                )}
                {entityRebuild.indexState.status === 'failed' && (
                  <span className="text-destructive">
                    {t('aiSettings.entityIndexFailed')}
                    {entityRebuild.indexState.error ? ` · ${entityRebuild.indexState.error}` : ''}
                  </span>
                )}
                {entityRebuild.indexState.status === 'rebuilding' && t('aiSettings.entityIndexRebuilding')}
              </p>
            )}
            {(entityRebuild?.running || (entityRebuild && (entityRebuild.total > 0 || entityRebuild.errors > 0))) && (
              <p className="tabular-nums text-muted-foreground break-words">
                {entityRebuild.running && entityRebuild.total === 0
                  ? t('aiSettings.entityRebuildScanning')
                  : t('aiSettings.entityRebuildProgress', {
                      done: entityRebuild.done,
                      total: entityRebuild.total,
                    })}
                {(entityRebuild.skipped ?? 0) > 0 &&
                  t('aiSettings.entityRebuildSkipped', { n: entityRebuild.skipped })}
                {entityRebuild.eta_ms != null && entityRebuild.eta_ms > 0 && entityRebuild.running && (
                  t('aiSettings.entityRebuildEta', { minutes: Math.max(1, Math.ceil(entityRebuild.eta_ms / 60000)) })
                )}
                {entityRebuild.errors > 0 && t('aiSettings.entityRebuildErrors', { n: entityRebuild.errors })}
                {entityRebuild.last_error && (
                  <span className="text-destructive" title={entityRebuild.last_error}>
                    {' '}· {entityRebuild.last_error}
                  </span>
                )}
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
            <p className="text-sm text-muted-foreground/80 leading-relaxed">
              {t('aiSettings.braveApiHint1')} <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">{t('aiSettings.braveApiKey')}</a>{t('aiSettings.braveApiHint2')}
            </p>
          </div>
        )}
      </SettingsCard>

      {/* Sticky 保存栏：始终悬浮在视口底部，避免「改完顶部配置找不到保存按钮」；
          有未保存修改时高亮 + 提示（dirty 检测见上方 useMemo） */}
      <div className={`sticky bottom-0 z-header -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 mt-4 border-t bg-background/85 backdrop-blur-md ${dirty ? 'border-warning/40' : 'border-border/60'}`}>
        <div className="flex items-center gap-2 flex-wrap">
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
            className={dirty ? 'ring-2 ring-warning/50' : undefined}
          >
            {t('aiSettings.saveConfig')}
          </ActionButton>
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {t('aiSettings.refreshStatus')}
          </button>
          {dirty && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-warning">
              <TriangleAlert className="w-4 h-4" />
              {t('aiSettings.unsavedChanges')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** 分组小标题（模型配置 / 功能） */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 pt-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground/70 select-none">
      {children}
    </h3>
  )
}
