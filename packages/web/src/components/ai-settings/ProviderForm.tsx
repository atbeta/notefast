import { Plus, X, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  PRESETS,
  PROVIDER_PRESET_IDS,
  KEY_MASK,
  type ProviderDefinition,
  type ProviderPresetId,
} from '@notefast/core'
import { FieldRow, Input, Tooltip } from '../ui'
import { InlineField } from '../settings/ui'
import type { FieldErrors } from './validation'

// ───────────── Provider Form（Chat、Embedding 和 Reranker 共用）─────────────

export function ProviderForm({
  value,
  onChange,
  mode,
  knownModels,
  modelLabel,
  fieldErrors,
}: {
  value: ProviderDefinition
  onChange: (v: ProviderDefinition) => void
  mode: 'chat' | 'embedding' | 'reranker'
  knownModels: string[]
  modelLabel: string
  fieldErrors?: FieldErrors
}) {
  const { t } = useTranslation()
  const preset = PRESETS[value.preset]
  const errBaseUrl = fieldErrors?.baseUrl
  const errModel = mode === 'chat' ? fieldErrors?.chatModel : fieldErrors?.embeddingModel
  const errTimeout = fieldErrors?.timeoutMs
  const availablePresets = PROVIDER_PRESET_IDS.filter(id => PRESETS[id].supportedModes.includes(mode))

  const handlePresetChange = (newPreset: ProviderPresetId) => {
    const p = PRESETS[newPreset]
    if (value.preset === newPreset) {
      onChange({
        ...value,
        preset: newPreset,
        baseUrl: p.baseUrl,
        extraHeaders: { ...p.extraHeaders },
      })
      return
    }
    onChange({
      ...value,
      preset: newPreset,
      baseUrl: p.baseUrl,
      // reranker 模式的模型字段走独立的 rerankerModel（与 embedding 解耦，
      // 否则选 SiliconFlow 会把 Qwen3-Embedding 错填成 rerank 模型）
      embeddingModel: mode === 'chat' ? '' : mode === 'reranker' ? p.rerankerModel : p.embeddingModel,
      chatModel: mode === 'chat' ? p.chatModel : '',
      extraHeaders: { ...p.extraHeaders },
      apiKey: '',
      label: p.label,
    })
  }

  return (
    <div className="space-y-3">
      <FieldRow label={t('providerForm.preset')}>
        <div className="flex items-center gap-2 min-w-0">
          <select
            value={value.preset}
            onChange={(e) => handlePresetChange(e.target.value as ProviderPresetId)}
            className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-md border border-border bg-background truncate"
          >
            {availablePresets.map((id) => (
              <option key={id} value={id}>
                {id === 'custom' 
                  ? (mode === 'reranker' ? t('providerForm.customReranker') : t('providerForm.customOpenai'))
                  : PRESETS[id].label}
              </option>
            ))}
          </select>
          {preset?.signupUrl && (
            <Tooltip label={t('providerForm.getApiKeyTitle')}>
              <a
                href={preset.signupUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="w-3 h-3" />
                {t('providerForm.getApiKey')}
              </a>
            </Tooltip>
          )}
        </div>
      </FieldRow>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
        <div className="md:col-span-2">
          <InlineField
            label="API Key"
            description={t('aiSettings.keepUnchanged')}
            value={value.apiKey === KEY_MASK ? '' : value.apiKey}
            onChange={(v) => onChange({ ...value, apiKey: v === '' && value.apiKey === KEY_MASK ? KEY_MASK : v })}
            placeholder={value.apiKey === KEY_MASK ? t('aiSettings.savedKey') : 'sk-...'}
            type="password"
            mono
          />
        </div>
        <div className="md:col-span-2">
          <InlineField
            label="Base URL"
            value={value.baseUrl}
            onChange={(v) => onChange({ ...value, baseUrl: v })}
            placeholder={mode === 'reranker' ? 'http://127.0.0.1:8080' : 'https://api.openai.com/v1'}
            status={errBaseUrl ? 'error' : undefined}
            statusMessage={errBaseUrl}
            mono
          />
        </div>
        <div className="md:col-span-2">
          <FieldRow label={modelLabel} error={errModel}>
            <Input
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
              placeholder={mode === 'chat' ? 'deepseek-chat / gpt-4o-mini' : mode === 'embedding' ? 'jina-embeddings-v3 / voyage-3' : 'jina-reranker-v3 / voyage-rerank-2'}
              aria-invalid={!!errModel}
              invalid={!!errModel}
              mono
              className="text-sm"
            />
            <datalist id={`known-${mode}-models`}>
              {knownModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </FieldRow>
        </div>
        <InlineField
          label={t('providerForm.timeout')}
          description={t('providerForm.timeoutUnit')}
          value={String(value.timeoutMs)}
          onChange={(v) => onChange({ ...value, timeoutMs: parseInt(v, 10) || 60000 })}
          type="number"
          status={errTimeout ? 'error' : undefined}
          statusMessage={errTimeout}
          mono
        />
        <InlineField
          label={t('providerForm.displayName')}
          value={value.label}
          onChange={(v) => onChange({ ...value, label: v })}
          placeholder={mode === 'chat' ? t('providerForm.placeholderChat') : t('providerForm.placeholderEmbed')}
        />
      </div>
      <FieldRow label={t('providerForm.extraHeaders')} hint={t('providerForm.extraHeadersHint')}>
        <ExtraHeadersEditor
          entries={Object.entries(value.extraHeaders || {})}
          onChange={(entries) => onChange({ ...value, extraHeaders: Object.fromEntries(entries) })}
        />
      </FieldRow>
    </div>
  )
}

function ExtraHeadersEditor({
  entries,
  onChange,
}: {
  entries: [string, string][]
  onChange: (entries: [string, string][]) => void
}) {
  const { t } = useTranslation()
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
          <Input
            type="text"
            value={k}
            onChange={(e) => update(idx, [e.target.value, v])}
            placeholder="Header-Name"
            mono
            className="flex-1 text-xs"
          />
          <Input
            type="text"
            value={v}
            onChange={(e) => update(idx, [k, e.target.value])}
            placeholder="value"
            mono
            className="flex-1 text-xs"
          />
          <button type="button" onClick={() => remove(idx)} className="p-1 text-muted-foreground hover:text-destructive">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="w-3 h-3" />
        {t('providerForm.addHeader')}
      </button>
    </div>
  )
}
