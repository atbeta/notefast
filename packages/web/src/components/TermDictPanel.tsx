/**
 * 实体词典面板（结构化编辑器）
 *
 * 替代原始 JSON 文本框：长词典可搜索、条目级增删改、导入合并（外挂行业词典）、导出。
 * 条目增删改 / 导入 / 清空立即 PUT 落盘 + 自动存量归并；底部「保存」会顺带提交未关的表单。
 * JSON 格式错误在结构上不可能发生；导入在预览阶段校验。
 * 描述（description）只在这里写：用户声明层，优先级高于 AI 生成。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookMarked, Plus, RefreshCw, Trash2, Search, Pencil, X, Download, Upload, FileUp } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, Tooltip, useToast } from './ui'
import { SettingsCard } from './settings/ui'

interface TermDictEntry {
  name: string
  aliases: string[]
  kind?: string
  description?: string
}

interface TermDictPayload {
  enabled: boolean
  count: number
  alias_count: number
  terms: TermDictEntry[]
}

const KINDS = ['concept', 'person', 'tool', 'doc'] as const

type EditingState =
  | { mode: 'new' }
  | { mode: 'edit'; index: number }
  | null

interface EntryForm {
  name: string
  aliases: string[]
  aliasDraft: string
  kind: string
  description: string
}

const emptyForm: EntryForm = { name: '', aliases: [], aliasDraft: '', kind: '', description: '' }

/** 本地轻量归一（服务端 dictKey 为准；这里只用于去重/合并预览） */
function normName(s: string): string {
  return s.trim().toLowerCase()
}

export default function TermDictPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [stats, setStats] = useState<{ enabled: boolean; count: number; aliasCount: number } | null>(null)
  const [terms, setTerms] = useState<TermDictEntry[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<EditingState>(null)
  const [form, setForm] = useState<EntryForm>(emptyForm)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api
      .get<TermDictPayload>('/term-dict')
      .then((d) => {
        setStats({ enabled: d.enabled, count: d.count, aliasCount: d.alias_count })
        setTerms(d.terms)
      })
      .catch(() => setStats(null))
  }, [])

  // ───────────────────── 列表与搜索 ─────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return terms
    return terms.filter(
      (e) => e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)),
    )
  }, [terms, search])

  // ───────────────────── 表单 ─────────────────────

  const startNew = () => {
    setForm(emptyForm)
    setEditing({ mode: 'new' })
  }

  const startEdit = (index: number) => {
    const e = terms[index]!
    setForm({
      name: e.name,
      aliases: [...e.aliases],
      aliasDraft: '',
      kind: e.kind ?? '',
      description: e.description ?? '',
    })
    setEditing({ mode: 'edit', index })
  }

  const cancelEdit = () => {
    setEditing(null)
    setForm(emptyForm)
  }

  const addAlias = () => {
    const raw = form.aliasDraft.trim()
    if (!raw) return
    const parts = raw.split(/[,，]/).map((p) => p.trim()).filter(Boolean)
    setForm((f) => ({
      ...f,
      aliasDraft: '',
      aliases: [...new Set([...f.aliases, ...parts])],
    }))
  }

  const removeAlias = (alias: string) => {
    setForm((f) => ({ ...f, aliases: f.aliases.filter((a) => a !== alias) }))
  }

  const persistTerms = async (next: TermDictEntry[]) => {
    const d = await api.put<TermDictPayload>('/term-dict', { terms: next })
    setTerms(d.terms)
    setStats({ enabled: d.enabled, count: d.count, aliasCount: d.alias_count })
  }

  const persistWithToast = async (next: TermDictEntry[], success?: string): Promise<boolean> => {
    try {
      await toast.promise(() => persistTerms(next), {
        loading: t('settings.termDict.saving'),
        success: success ?? t('settings.termDict.saved'),
        error: (e) => ({
          title: t('settings.termDict.saveFailed'),
          description: e instanceof Error ? e.message : String(e),
        }),
      })
      return true
    } catch {
      return false
    }
  }

  const buildEntryFromForm = (): TermDictEntry | null => {
    const name = form.name.trim()
    if (!name) {
      toast.error({ title: t('settings.termDict.nameRequired') })
      return null
    }
    const dupIndex = terms.findIndex((e) => normName(e.name) === normName(name))
    if (editing?.mode === 'edit' && dupIndex !== editing.index && dupIndex >= 0) {
      toast.error({ title: t('settings.termDict.nameDuplicate') })
      return null
    }
    if (editing?.mode !== 'edit' && dupIndex >= 0) {
      toast.error({ title: t('settings.termDict.nameDuplicate') })
      return null
    }
    return {
      name,
      aliases: form.aliases,
      ...(form.kind ? { kind: form.kind } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
    }
  }

  const applyEntry = (entry: TermDictEntry): TermDictEntry[] => {
    if (editing?.mode === 'edit') {
      const next = [...terms]
      next[editing.index] = entry
      return next
    }
    return [...terms, entry]
  }

  const submitEntry = async () => {
    const entry = buildEntryFromForm()
    if (!entry) return
    if (await persistWithToast(applyEntry(entry))) cancelEdit()
  }

  const deleteEntry = async (index: number) => {
    if (await persistWithToast(terms.filter((_, i) => i !== index))) {
      if (editing?.mode === 'edit' && editing.index === index) cancelEdit()
    }
  }

  // ───────────────────── 导入合并 ─────────────────────

  const parseImport = (raw: string) => {
    setImportError('')
    let list: unknown
    try {
      list = JSON.parse(raw)
    } catch {
      setImportError(t('settings.termDict.importInvalid'))
      return
    }
    if (!Array.isArray(list)) {
      setImportError(t('settings.termDict.importInvalid'))
      return
    }
    const incoming: TermDictEntry[] = []
    for (const item of list as Array<Record<string, unknown>>) {
      if (typeof item?.name !== 'string' || !item.name.trim()) continue
      const aliases = Array.isArray(item.aliases)
        ? (item.aliases as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
        : []
      const kind = typeof item.kind === 'string' && (KINDS as readonly string[]).includes(item.kind) ? item.kind : undefined
      const description = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined
      incoming.push({ name: item.name.trim(), aliases, ...(kind ? { kind } : {}), ...(description ? { description } : {}) })
    }
    let add = 0
    let update = 0
    const merged = [...terms]
    for (const inc of incoming) {
      const idx = merged.findIndex((e) => normName(e.name) === normName(inc.name))
      if (idx >= 0) {
        merged[idx] = { ...merged[idx]!, ...inc, aliases: [...new Set([...merged[idx]!.aliases, ...inc.aliases])] }
        update++
      } else {
        merged.push(inc)
        add++
      }
    }
    void persistWithToast(
      merged,
      t('settings.termDict.importPreview', { add, update, skip: incoming.length - add - update }),
    ).then((ok) => {
      if (!ok) return
      setImportOpen(false)
      setImportText('')
    })
  }

  const onImportFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => parseImport(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  // ───────────────────── 导出 / 保存 / 归并 / 清空 ─────────────────────

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({ version: 1, terms }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'term-dict.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSave = async () => {
    let next = terms
    if (editing) {
      const entry = buildEntryFromForm()
      if (!entry) return
      next = applyEntry(entry)
    }
    if (await persistWithToast(next)) cancelEdit()
  }

  const handleRebuild = async () => {
    try {
      const r = await api.post<{ merged: number; created: number; kindUpdated: number }>('/term-dict/rebuild', {})
      toast.success({
        title: t('settings.termDict.rebuildDone'),
        description: t('settings.termDict.rebuildResult', {
          merged: r.merged,
          created: r.created,
          kindUpdated: r.kindUpdated,
        }),
      })
    } catch (e) {
      toast.error({ title: t('settings.termDict.rebuildFailed'), description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleClear = async () => {
    cancelEdit()
    await persistWithToast([])
  }

  const formDup = terms.some(
    (e) => normName(e.name) === normName(form.name) && !(editing?.mode === 'edit' && terms[editing.index]?.name === e.name),
  )

  return (
    <SettingsCard
      title={t('settings.termDict.title')}
      icon={<BookMarked className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('settings.termDict.helpTip')}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.termDict.description')}</p>

        {/* 工具行：状态 + 搜索 + 操作 */}
        <div className="flex flex-wrap items-center gap-2">
          {stats && (
            stats.enabled ? (
              <span className="px-2 py-1 rounded-md bg-primary-soft text-primary font-medium text-sm">
                {t('settings.termDict.enabled', { count: stats.count, aliases: stats.aliasCount })}
              </span>
            ) : (
              <span className="px-2 py-1 rounded-md bg-muted text-muted-foreground text-sm">
                {t('settings.termDict.disabled')}
              </span>
            )
          )}
          <div className="flex-1 min-w-[140px]" />
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.75} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('settings.termDict.searchPlaceholder')}
              className="pl-8 pr-3 py-1.5 w-52 rounded-md border border-border/60 bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40"
            />
          </div>
          <ActionButton variant="secondary" size="sm" onAction={startNew}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('settings.termDict.addEntry')}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" onAction={() => setImportOpen((v) => !v)}>
            <Upload className="w-3.5 h-3.5 mr-1" />
            {t('settings.termDict.importTitle')}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" onAction={handleExport}>
            <Download className="w-3.5 h-3.5 mr-1" />
            {t('settings.termDict.export')}
          </ActionButton>
        </div>

        {/* 新增/编辑表单 */}
        {editing && (
          <div className="rounded-lg border border-primary/30 bg-primary-softer/40 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('settings.termDict.nameLabel')}</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('settings.termDict.nameLabel')}
                  autoFocus
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-base text-foreground placeholder:text-muted-foreground/40 "
                />
                {formDup && <p className="text-2xs text-destructive">{t('settings.termDict.nameDuplicate')}</p>}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('settings.termDict.kindLabel')}</label>
                <select
                  value={form.kind}
                  onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-base text-foreground "
                >
                  <option value="">—</option>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{t(`settings.termDict.kind.${k}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('settings.termDict.aliasesLabel')} <span className="text-muted-foreground/60">· {t('settings.termDict.aliasesHint')}</span>
              </label>
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5">
                {form.aliases.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-muted/70 text-xs font-mono text-foreground/85">
                    {a}
                    <button type="button" onClick={() => removeAlias(a)} className="w-3.5 h-3.5 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive">
                      <X className="w-2.5 h-2.5" strokeWidth={2} />
                    </button>
                  </span>
                ))}
                <input
                  value={form.aliasDraft}
                  onChange={(e) => setForm((f) => ({ ...f, aliasDraft: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      addAlias()
                    }
                  }}
                  onBlur={addAlias}
                  placeholder="wafer, 晶圆片"
                  data-no-focus-ring
                  className="flex-1 min-w-[100px] bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground/40"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('settings.termDict.descriptionLabel')}</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t('settings.termDict.descriptionPlaceholder')}
                rows={2}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40  resize-y"
              />
            </div>
            <div className="flex items-center gap-2">
              <ActionButton size="sm" onAction={submitEntry}>{t('settings.termDict.saveEntry')}</ActionButton>
              <ActionButton variant="ghost" size="sm" onAction={cancelEdit}>{t('common.cancel')}</ActionButton>
            </div>
          </div>
        )}

        {/* 导入合并 */}
        {importOpen && (
          <div className="rounded-lg border border-border p-4 space-y-3 bg-accent/20">
            <div className="text-sm text-muted-foreground">{t('settings.termDict.importHint')}</div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder='[ { "name": "晶圆", "aliases": ["wafer"] } ]'
              className="w-full rounded-md border border-border bg-background p-2.5 font-mono text-sm text-foreground "
            />
            {importError && <p className="text-xs text-destructive">{importError}</p>}
            <div className="flex items-center gap-2">
              <ActionButton size="sm" onAction={() => parseImport(importText)} disabled={!importText.trim()}>
                {t('settings.termDict.importConfirm')}
              </ActionButton>
              <ActionButton variant="secondary" size="sm" onAction={() => fileRef.current?.click()}>
                <FileUp className="w-3.5 h-3.5 mr-1" />
                {t('settings.termDict.importFile')}
              </ActionButton>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onImportFile(f)
                  e.target.value = ''
                }}
              />
              <ActionButton variant="ghost" size="sm" onAction={() => setImportOpen(false)}>{t('common.cancel')}</ActionButton>
            </div>
          </div>
        )}

        {/* 条目列表 */}
        <div className="rounded-lg border border-border/70 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {terms.length === 0 ? t('settings.termDict.disabled') : t('settings.termDict.noResults')}
            </div>
          ) : (
            filtered.map((e, fi) => {
              const index = terms.indexOf(e)
              return (
                <div key={e.name} className={`flex items-start gap-3 px-4 py-2.5 ${fi !== filtered.length - 1 ? 'border-b border-border/40' : ''} bg-background`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-medium text-foreground">{e.name}</span>
                      {e.kind && (
                        <span className="px-1.5 py-px rounded-md text-2xs uppercase tracking-wider font-mono bg-accent text-muted-foreground border border-border/50">
                          {t(`settings.termDict.kind.${e.kind}`)}
                        </span>
                      )}
                    </div>
                    {e.aliases.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {e.aliases.map((a) => (
                          <span key={a} className="px-1.5 py-px rounded-full bg-muted/60 text-2xs font-mono text-muted-foreground">{a}</span>
                        ))}
                      </div>
                    )}
                    {e.description && (
                      <p className="text-sm text-muted-foreground/80 mt-1 leading-relaxed">{e.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip label={t('settings.termDict.edit')}>
                      <button
                        type="button"
                        onClick={() => startEdit(index)}
                        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('settings.termDict.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('settings.termDict.delete')}>
                      <button
                        type="button"
                        onClick={() => deleteEntry(index)}
                        className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={t('settings.termDict.delete')}
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-3">
          <ActionButton onAction={handleSave}>{t('settings.termDict.save')}</ActionButton>
          <ActionButton variant="secondary" onAction={handleRebuild}>
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
            {t('settings.termDict.rebuild')}
          </ActionButton>
          {terms.length > 0 && (
            <ActionButton variant="secondary" onAction={handleClear}>
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              {t('settings.termDict.clear')}
            </ActionButton>
          )}
        </div>
      </div>
    </SettingsCard>
  )
}
