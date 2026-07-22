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
import { ActionButton, useToast, Toggle, FieldRow } from '../ui'
import ConfirmDialog from '../ConfirmDialog'
import { ProviderForm } from './ProviderForm'
import { DiagnosePanel } from './DiagnosePanel'
import { Section, AutoLinkOption, CapabilityBadge } from './primitives'
import { errorsToFields, localValidate, serverValidationErrors, type FormErrors } from './validation'

/**
 * /ai/status 响应 = core RuntimeStatus + 服务端附加字段。
 * vectorStore / fix_hint 是 server 私有类型（core 未建模），web 暂不消费，
 * 以交叉类型保留字段，避免丢失。
 */
type AIStatus = RuntimeStatus & {
  vectorStore?: unknown
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

  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [diagnose, setDiagnose] = useState<AiDiagnoseResult | null>(null)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
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

  const handleDisable = async () => {
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
        <DiagnosePanel result={diagnose} onClose={() => setDiagnose(null)} />
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
          <div className="mt-4 space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                自动应用策略
              </div>
              <div className="grid gap-2" role="radiogroup" aria-label="自动应用策略">
                <AutoLinkOption
                  selected={autoLink.autoApply === 'never'}
                  title="仅建议"
                  description="AI 抽取实体进 Inbox，但不写 block_refs；用户接受后才落地。"
                  onSelect={() => setAutoLink({ ...autoLink, autoApply: 'never' })}
                />
                <AutoLinkOption
                  selected={autoLink.autoApply === 'high_confidence'}
                  title="高置信自动应用"
                  description="满足 minConfidence 且 top-1 显著领先时自动写入，其余进 Inbox。"
                  onSelect={() => setAutoLink({ ...autoLink, autoApply: 'high_confidence' })}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <FieldRow label="minConfidence">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  value={autoLink.minConfidence}
                  onChange={(e) => setAutoLink({ ...autoLink, minConfidence: parseFloat(e.target.value) || 0 })}
                />
              </FieldRow>
              <FieldRow label="minMargin">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  value={autoLink.minMargin}
                  onChange={(e) => setAutoLink({ ...autoLink, minMargin: parseFloat(e.target.value) || 0 })}
                />
              </FieldRow>
              <FieldRow label="每块最大建议数">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={autoLink.maxPerBlock}
                  onChange={(e) => setAutoLink({ ...autoLink, maxPerBlock: Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 5)) })}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </FieldRow>
            </div>

            <FieldRow label="Notebook 范围">
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
            onClick={() => setShowDisableConfirm(true)}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-destructive hover:bg-destructive/10 ml-auto"
          >
            禁用 AI
          </button>
        )}
      </div>

      <ConfirmDialog
        open={showDisableConfirm}
        title="禁用 AI"
        message="禁用 AI 会清空所有 Chat / Embedding / Reranker 配置。继续？"
        confirmLabel="禁用"
        destructive
        onCancel={() => setShowDisableConfirm(false)}
        onConfirm={() => {
          setShowDisableConfirm(false)
          void handleDisable()
        }}
      />
    </div>
  )
}
