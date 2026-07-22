import { Eye, EyeOff, Plus, X, ExternalLink } from 'lucide-react'
import {
  PRESETS,
  PRESETS_BY_REGION,
  REGION_LABELS,
  REGION_ORDER,
  KEY_MASK,
  type ProviderDefinition,
  type ProviderPresetId,
  type Region,
} from '@notefast/core'
import { FieldRow } from '../ui'
import type { FieldErrors } from './validation'

// ───────────── Provider Form（Chat 和 Embedding 共用）─────────────

export function ProviderForm({
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
