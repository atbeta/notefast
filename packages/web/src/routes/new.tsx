import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, X, Upload, Sparkles, Loader2, Tag, Plus } from 'lucide-react'
import type { Notebook } from '@notefast/core'
import { request, fetchWithAuth, ApiError } from '../hooks/useAPI'
import { currentLocale } from '../lib/time'
import PageHeader from '../components/PageHeader'
import SubNavTabs from '../components/SubNavTabs'
import TagPickerPopover from '../components/TagPickerPopover'
import { useAiCapabilities } from '../hooks/useAiCapabilities'
import { Tooltip, useToast } from '../components/ui'

export default function NewDocPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const ai = useAiCapabilities()
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  /** 随 md 导入的图片文件（webkitRelativePath 或 name 保留相对路径，收编用） */
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'create' | 'import'>('create')
  const [generating, setGenerating] = useState(false)
  const [zipImporting, setZipImporting] = useState(false)
  const [zipResult, setZipResult] = useState<{
    imported: number
    skipped: number
    failed: number
    media_imported: number
    errors: string[]
  } | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const tagTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    request<Notebook[]>('/notebooks')
      .then((list) => { if (list.length > 0) setNotebookId(list[0].id) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    titleInputRef.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setError('')

    const finalTitle = title.trim() || new Date().toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' })

    try {
      let docId: string
      let indexJobId: string | undefined
      if (markdown.trim()) {
        if (imageFiles.length > 0) {
          // 带图片：multipart 上传，服务端按相对路径收编为 asset:<sha> 并重写引用
          const fd = new FormData()
          fd.append('markdown', markdown)
          fd.append('notebook_id', notebookId)
          fd.append('title', finalTitle)
          if (tags.length > 0) fd.append('tags', JSON.stringify(tags))
          for (const f of imageFiles) {
            // 相对路径优先 webkitRelativePath（拖文件夹），否则 name（多选文件）
            const rel = f.webkitRelativePath || f.name
            fd.append('images', f, rel)
          }
          const res = await fetchWithAuth('/import/markdown-files', { method: 'POST', body: fd })
          const body = await res.json() as { doc: { id: string }; index_job?: { id: string } }
          if (!res.ok) throw new ApiError((body as { message?: string } | null)?.message || `HTTP ${res.status}`, res.status, body)
          docId = body.doc.id
          indexJobId = body.index_job?.id
        } else {
          const res = await request<{ doc: { id: string }; index_job?: { id: string } }>('/import/markdown', {
            method: 'POST',
            body: JSON.stringify({ notebook_id: notebookId, markdown, title: finalTitle, tags }),
          })
          docId = res.doc.id
          indexJobId = res.index_job?.id
        }
      } else {
        const res = await request<{ id: string; index_job?: { id: string } }>('/docs', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, title: finalTitle, tags }),
        })
        docId = res.id
        indexJobId = res.index_job?.id
      }
      // 内容已随创建入库——落地阅读态（不带 edit=1），向量化进度经 index_job 参数照常展示
      const q = new URLSearchParams()
      if (indexJobId) q.set('index_job', indexJobId)
      const qs = q.toString()
      navigate('/doc/' + docId + (qs ? '?' + qs : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('newDoc.createFailed'))
      setCreating(false)
    }
  }

  const handleCancel = () => navigate('/')

  const handleRemoveTag = (tag: string) => {
    setTags((prev) => prev.filter((item) => item !== tag))
  }

  const handleSuggestTitle = async () => {
    const source = markdown.trim() || title.trim()
    if (!source || generating) return
    if (!ai.chat) {
      toast.info({ title: t('newDoc.aiTitleNeedChat') })
      return
    }
    setGenerating(true)
    try {
      const res = await request<{ title: string; summary: string }>('/ai/suggest-title', {
        method: 'POST',
        body: JSON.stringify({ content: source }),
      })
      if (!title.trim()) setTitle(res.title)
      else if (!title.trim().includes(res.title)) setTitle(res.title)
    } catch {
      toast.error({ title: t('newDoc.aiTitleNeedChat') })
    }
    finally { setGenerating(false) }
  }

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files)
    // zip：直接上传批量导入（后端 /import/zip：每个 .md 建一篇文档，自家导出档按 manifest 还原）
    const zip = list.find((f) => f.name.toLowerCase().endsWith('.zip') || f.type === 'application/zip')
    if (zip) {
      void handleZipFile(zip)
      return
    }
    // 取第一个 md（或非图片非 zip 文本）作为文档内容；其余图片文件收集供收编
    const mdFile = list.find((f) => /\.(md|markdown|mdown|mkd)$/i.test(f.name)) ?? list[0]
    if (!mdFile) return
    const images = list.filter((f) => f !== mdFile && f.type.startsWith('image/'))
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setMarkdown(text)
      setImageFiles(images)
      if (!title.trim()) setTitle(mdFile.name.replace(/\.(md|markdown|mdown|mkd)$/i, ''))
      setActiveTab('create')
    }
    reader.readAsText(mdFile)
  }

  /** 上传 zip 批量导入；结果原地展示（成功/跳过/失败明细），可继续导入或返回文档库 */
  const handleZipFile = async (file: File) => {
    setZipImporting(true)
    setError('')
    setZipResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (notebookId) fd.append('notebook_id', notebookId)
      const res = await fetchWithAuth('/import/zip', { method: 'POST', body: fd })
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (body as { message?: string } | null)?.message || `HTTP ${res.status}`
        throw new ApiError(message, res.status, body)
      }
      setZipResult(body as { imported: number; skipped: number; failed: number; media_imported: number; errors: string[] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setZipImporting(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    // 支持拖入文件夹/多选：webkitRelativePath 保留相对路径供图片收编
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
  }

  return (
    <div className="animate-fade-in">
      {/* 全局顶栏：h-14 + 底边框，与侧边栏顶栏贯通 */}
      <PageHeader>
        <SubNavTabs
          embedded
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'create' | 'import')}
          tabs={[
            { key: 'create', label: t('newDoc.tabCreate') },
            { key: 'import', label: t('newDoc.tabImport') },
          ]}
          trailing={
            <Link
              to="/"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{t('common.back')}</span>
            </Link>
          }
        />
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-8 pb-16">
      {activeTab === 'create' && (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor="doc-title" className="text-[12px] font-medium text-muted-foreground">{t('common.title')}</label>
              {ai.chat && (
              <Tooltip label={t('newDoc.aiTitleHint')}>
                <button
                  type="button"
                  onClick={handleSuggestTitle}
                  disabled={generating || (!markdown.trim() && !title.trim())}
                  className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                >
                  {generating ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Sparkles className="w-3 h-3" strokeWidth={1.75} />
                  )}
                  {generating ? t('newDoc.generating') : t('newDoc.aiTitle')}
                </button>
              </Tooltip>
              )}
            </div>
            <input
              id="doc-title"
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (error) setError('') }}
              placeholder={t('newDoc.untitledPlaceholder')}
              className={'input-underline ' + (error ? 'error' : '')}
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label htmlFor="doc-markdown" className="text-[12px] font-medium text-muted-foreground">{t('newDoc.markdownLabel')}</label>
              <span className="text-[11.5px] text-muted-foreground/60">{t('newDoc.optional')}</span>
            </div>
            <textarea
              id="doc-markdown"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder={t('newDoc.markdownPlaceholder')}
              rows={9}
              className="input-mono"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[12px] font-medium text-muted-foreground">{t('newDoc.tagsLabel')}</label>
              <span className="text-[11.5px] text-muted-foreground/60">{t('newDoc.optional')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" strokeWidth={1.75} />
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11.5px] bg-muted/60 text-foreground/85"
                >
                  <span className="font-mono">{tag}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="w-4 h-4 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive hover:bg-background/60 transition-colors"
                  >
                    <X className="w-3 h-3" strokeWidth={2} />
                  </button>
                </span>
              ))}
              <button
                ref={tagTriggerRef}
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label={t('tagEditor.pickTag')}
                className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full border border-dashed border-border/70 hover:border-foreground/30 text-muted-foreground/70 hover:text-foreground transition-colors"
              >
                <Plus className="w-3 h-3 text-muted-foreground/60" strokeWidth={2} />
                <span className="text-[11.5px]">{t('tagEditor.addTag')}</span>
              </button>
              {pickerOpen && (
                <TagPickerPopover
                  anchorRef={tagTriggerRef}
                  existing={tags}
                  onPick={(tag) => {
                    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag].sort()))
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/8 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/60">
            <button
              type="button"
              onClick={handleCancel}
              className="btn-ghost-custom"
            >
              <X className="w-3.5 h-3.5" />
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={creating}
              className="btn-primary-custom"
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2.25} />
              {creating ? t('newDoc.creating') : t('newDoc.createAndOpen')}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'import' && (
        <div className="py-4 space-y-4">
          {!zipResult && (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="block border border-dashed border-border-strong/60 rounded-lg text-center py-16 px-6 cursor-pointer hover:border-foreground/30 hover:bg-muted/40 transition-colors"
            >
              <div className="empty-icon-tile mx-auto">
                <Upload className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">{t('newDoc.dropHint')}</p>
              <p className="text-xs text-muted-foreground">{t('newDoc.dropHintSub')}</p>
              <input
                type="file"
                accept=".md,.markdown,text/markdown,.zip,application/zip,image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          )}

          {zipImporting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              {t('newDoc.zipImporting')}
            </div>
          )}

          {error && !zipResult && !zipImporting && (
            <p className="text-xs text-destructive bg-destructive/8 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          {zipResult && !zipImporting && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-500" strokeWidth={2.25} />
                {t('newDoc.zipImported', { n: zipResult.imported })}
                {zipResult.media_imported > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('newDoc.zipMediaImported', { n: zipResult.media_imported })}
                  </span>
                )}
              </p>
              {(zipResult.skipped > 0 || zipResult.failed > 0) && (
                <p className="text-xs text-muted-foreground">
                  {zipResult.skipped > 0 && t('newDoc.zipSkipped', { n: zipResult.skipped })}
                  {zipResult.skipped > 0 && zipResult.failed > 0 && ' · '}
                  {zipResult.failed > 0 && t('newDoc.zipFailed', { n: zipResult.failed })}
                </p>
              )}
              {zipResult.errors.length > 0 && (
                <ul className="text-[11.5px] text-destructive/90 space-y-0.5 max-h-28 overflow-y-auto pl-1">
                  {zipResult.errors.map((msg, i) => (
                    <li key={i} className="truncate" title={msg}>{msg}</li>
                  ))}
                </ul>
              )}
              {error && !zipImporting && (
                <p className="text-xs text-destructive">{error}</p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setZipResult(null); setError('') }}
                  className="btn-ghost-custom"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {t('newDoc.importAnother')}
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="btn-primary-custom"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {t('newDoc.backToLibrary')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}