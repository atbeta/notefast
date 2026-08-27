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
import { ArchiveFolderCue } from '../components/TagEditor'
import { useAiCapabilities } from '../hooks/useAiCapabilities'
import { Button, Textarea, Tooltip, useToast } from '../components/ui'
import { classifyImportDrop, missingLocalImagesForImport } from '../lib/importDrop'

export default function NewDocPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const ai = useAiCapabilities()
  const [notebookId, setNotebookId] = useState('')
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  /** 当前 markdown 是否来自导入文件（手写新建不跑相对路径图拦截） */
  const [importedFromFile, setImportedFromFile] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'create' | 'import'>('create')
  const [generating, setGenerating] = useState(false)
  const [zipImporting, setZipImporting] = useState(false)
  const [docxImporting, setDocxImporting] = useState(false)
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

    // 仅从文件载入的 md 拦截相对路径图：浏览器拿不到同目录文件，散图也不再随拖接收编。
    // 手写新建不跑，避免示例语法 / 占位图挡住创建。
    const missingImgs = missingLocalImagesForImport(markdown, importedFromFile)
    if (missingImgs.length > 0) {
      setError(t('newDoc.missingLocalImages', { n: missingImgs.length, names: missingImgs.slice(0, 3).join('、') }))
      setCreating(false)
      return
    }

    const finalTitle = title.trim() || new Date().toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' })

    try {
      let docId: string
      let indexJobId: string | undefined
      if (markdown.trim()) {
        const res = await request<{ doc: { id: string }; index_job?: { id: string } }>('/import/markdown', {
          method: 'POST',
          body: JSON.stringify({ notebook_id: notebookId, markdown, title: finalTitle, tags }),
        })
        docId = res.doc.id
        indexJobId = res.index_job?.id
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
    if (generating) return
    // 空内容：显式反馈，不要点了没反应
    if (!source) {
      toast.info({ title: t('newDoc.aiTitleNoContent') })
      return
    }
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
      // 显式点击 = 明确要 AI 标题：有结果即应用
      if (res.title) setTitle(res.title)
    } catch {
      toast.error({ title: t('newDoc.aiTitleNeedChat') })
    }
    finally { setGenerating(false) }
  }

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files)
    const classified = classifyImportDrop(list)
    if (classified.status === 'multiple') {
      setError(t('newDoc.importMultipleFiles'))
      setZipResult(null)
      return
    }
    if (classified.status === 'unsupported') {
      setError(t('newDoc.importUnsupportedFile'))
      setZipResult(null)
      return
    }
    const file = list[0]!
    if (classified.status === 'zip') {
      void handleZipFile(file)
      return
    }
    if (classified.status === 'docx') {
      void handleDocxFile(file)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setMarkdown(text)
      setImportedFromFile(true)
      setError('')
      if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, ''))
      setActiveTab('create')
    }
    reader.readAsText(file)
  }

  /** 上传 docx 直接导入：服务端 mammoth 转 markdown 并入库（含内嵌图片收编） */
  const handleDocxFile = async (file: File) => {
    setDocxImporting(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (notebookId) fd.append('notebook_id', notebookId)
      const res = await fetchWithAuth('/import/docx', { method: 'POST', body: fd })
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (body as { message?: string } | null)?.message || `HTTP ${res.status}`
        throw new ApiError(message, res.status, body)
      }
      const b = body as { doc?: { id: string }; index_job?: { id: string } }
      const docId = b.doc?.id
      if (!docId) throw new ApiError(t('newDoc.docxImportFailed'), res.status, body)
      const q = new URLSearchParams()
      const indexJobId = b.index_job?.id
      if (indexJobId) q.set('index_job', indexJobId)
      const qs = q.toString()
      navigate('/doc/' + docId + (qs ? '?' + qs : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDocxImporting(false)
    }
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
              <label htmlFor="doc-title" className="text-sm font-medium text-muted-foreground">{t('common.title')}</label>
              {ai.chat && (
              <Tooltip label={t('newDoc.aiTitleHint')}>
                <button
                  type="button"
                  onClick={handleSuggestTitle}
                  disabled={generating || (!markdown.trim() && !title.trim())}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
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
              <label htmlFor="doc-markdown" className="text-sm font-medium text-muted-foreground">{t('newDoc.markdownLabel')}</label>
              <span className="text-xs text-muted-foreground/60">{t('newDoc.optional')}</span>
            </div>
            <Textarea
              id="doc-markdown"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder={t('newDoc.markdownPlaceholder')}
              rows={9}
              mono
              className="min-h-[12rem] py-2.5 text-sm leading-relaxed"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-sm font-medium text-muted-foreground">{t('newDoc.tagsLabel')}</label>
              <span className="text-xs text-muted-foreground/60">{t('newDoc.optional')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" strokeWidth={1.75} />
              {tags.map((tag, i) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs bg-muted/60 text-foreground/85"
                >
                  {i === 0 && <ArchiveFolderCue />}
                  <span className="font-mono">{tag}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="w-4 h-4 rounded-full grid place-items-center text-muted-foreground/50 hover:text-destructive hover:bg-background/60 transition-colors"
                  >
                    <X className="w-3 h-3" strokeWidth={1.75} />
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
                <Plus className="w-3 h-3 text-muted-foreground/60" strokeWidth={1.75} />
                <span className="text-xs">{t('tagEditor.addTag')}</span>
              </button>
              {pickerOpen && (
                <TagPickerPopover
                  anchorRef={tagTriggerRef}
                  existing={tags}
                  onPick={(tag) => {
                    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
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
            <Button type="button" variant="ghost" onClick={handleCancel} icon={<X className="w-3.5 h-3.5" strokeWidth={1.75} />}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={creating}
              icon={<Check className="w-3.5 h-3.5" strokeWidth={1.75} />}
            >
              {creating ? t('newDoc.creating') : t('newDoc.createAndOpen')}
            </Button>
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
              <p className="text-xs text-muted-foreground mt-2">{t('newDoc.dropHintSub')}</p>
              <p className="text-xs text-muted-foreground">{t('newDoc.dropHintZip')}</p>
              <input
                type="file"
                accept=".md,.markdown,text/markdown,.txt,text/plain,.zip,application/zip,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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

          {docxImporting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              {t('newDoc.docxImporting')}
            </div>
          )}

          {error && !zipResult && !zipImporting && !docxImporting && (
            <p className="text-xs text-destructive bg-destructive/8 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          {zipResult && !zipImporting && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <Check className="w-4 h-4 text-success" strokeWidth={1.75} />
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
                <ul className="text-xs text-destructive/90 space-y-0.5 max-h-28 overflow-y-auto pl-1">
                  {zipResult.errors.map((msg, i) => (
                    <li key={i}>
                      <Tooltip label={msg} className="w-full min-w-0">
                        <span className="block w-full truncate">{msg}</span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
              {error && !zipImporting && (
                <p className="text-xs text-destructive">{error}</p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => { setZipResult(null); setError('') }}
                  icon={<Upload className="w-3.5 h-3.5" strokeWidth={1.75} />}
                >
                  {t('newDoc.importAnother')}
                </Button>
                <Button
                  type="button"
                  onClick={() => navigate('/')}
                  icon={<ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />}
                >
                  {t('newDoc.backToLibrary')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}