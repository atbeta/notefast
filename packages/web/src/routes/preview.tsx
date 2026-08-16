/**
 * OS 文件打开预览（/preview）
 *
 * 双击 .md / 从壳层传入路径 → 不入库，默认只读 Markdown 渲染；点「编辑」
 * 切入 CodeMirror 编辑器，可「导入到 NoteFast」（不入库前的容器语义）或
 * 「另存为副本」。与「Markdown 仅作表达与导出」的立场对齐：OS 给的 .md 是
 * 表达，入库是用户显式动作。
 *
 * 多文件：累积成队列，索引切换；关闭当前 = 弹出下一项；全部关完
 * 显示空态，由用户离开本页（不自动跳走）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Check, Eye, Pencil, Send, Download, X } from 'lucide-react'
import { ChatMarkdown, CodeMirrorEditor } from '@notefast/shared'
import type { CodeMirrorEditorHandle } from '@notefast/shared'
import PageHeader from '../components/PageHeader'
import { Tooltip, useToast } from '../components/ui'
import { useFilePreviewQueue } from '../hooks/useFileOpenEvents'
import { api } from '../hooks/useAPI'
import { deliverExport } from '../lib/download'

export default function PreviewPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const queue = useFilePreviewQueue()

  // 编辑态：就地编辑当前项内容（不入库，不进队列 store——队列项是「快照」）
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(false)
  const editorRef = useRef<CodeMirrorEditorHandle>(null)

  const current = queue.current

  // 切换当前项 / 进入编辑时装载草稿
  const currentContent = current?.content ?? ''
  const startEdit = () => {
    setDraft(currentContent)
    setEditing(true)
    setImported(false)
  }

  // 关闭预览：退出编辑态
  const closeCurrent = () => {
    setEditing(false)
    if (queue.total === 1) {
      queue.discardAll()
    } else {
      queue.discardCurrent()
    }
  }

  // 文件预览态：Esc 关闭当前（编辑态让编辑器自己处理 Esc）
  useEffect(() => {
    if (editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (queue.total === 0) return
      e.preventDefault()
      closeCurrent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, editing])

  const importTitle = current?.title || current?.path?.split('/').pop()?.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') || t('preview.untitled')

  const handleImport = async () => {
    if (!current) return
    setImporting(true)
    setImported(false)
    try {
      await api.post<{ doc?: { id: string } }>('/import/markdown', {
        markdown: draft,
        title: importTitle,
        status: 'inbox',
        source: {
          provider: 'file-open',
          external_id: current.path,
        },
      })
      setImported(true)
      toast.success({ title: t('preview.imported') })
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      toast.error({ title: `${t('preview.importFailed')}${msg ? `：${msg}` : ''}` })
    } finally {
      setImporting(false)
    }
  }

  const handleSaveCopy = async () => {
    const name = importTitle || '未命名'
    const blob = new Blob([draft], { type: 'text/markdown' })
    const result = await deliverExport(blob, `${name}.md`)
    if (result.mode === 'cancelled') return
    toast.success({ title: t('preview.savedCopy') })
  }

  const pageTitle = editing
    ? t('preview.editing', { title: importTitle })
    : current
      ? current.title || t('preview.untitled')
      : t('preview.title')

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.75} />
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            {pageTitle}
          </h1>
          {!editing && queue.total > 1 && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {queue.index + 1}/{queue.total}
            </span>
          )}
        </div>
        {queue.total > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {!editing && queue.total > 1 && (
              <>
                <Tooltip label={t('preview.prev')}>
                  <button
                    type="button"
                    disabled={!queue.hasPrev}
                    onClick={queue.prev}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft className="w-4 h-4" strokeWidth={1.75} />
                  </button>
                </Tooltip>
                <Tooltip label={t('preview.next')}>
                  <button
                    type="button"
                    disabled={!queue.hasNext}
                    onClick={queue.next}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronRight className="w-4 h-4" strokeWidth={1.75} />
                  </button>
                </Tooltip>
              </>
            )}
            {!editing && (
              <Tooltip label={t('preview.edit')}>
                <button
                  type="button"
                  onClick={startEdit}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] text-foreground hover:bg-accent transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                  {t('preview.edit')}
                </button>
              </Tooltip>
            )}
            {editing && (
              <>
                <Tooltip label={t('preview.import')}>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={importing}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                  >
                    {imported ? (
                      <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
                    ) : (
                      <Send className="w-3.5 h-3.5" strokeWidth={1.75} />
                    )}
                    {imported ? t('preview.imported') : t('preview.import')}
                  </button>
                </Tooltip>
                <Tooltip label={t('preview.saveCopy')}>
                  <button
                    type="button"
                    onClick={handleSaveCopy}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] text-foreground hover:bg-accent transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" strokeWidth={1.75} />
                    {t('preview.saveCopy')}
                  </button>
                </Tooltip>
                <Tooltip label={t('preview.backToPreview')}>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] text-foreground hover:bg-accent transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </Tooltip>
              </>
            )}
            <Tooltip label={t('preview.close')}>
              <button
                type="button"
                onClick={closeCurrent}
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </Tooltip>
          </div>
        )}
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16">
        {current ? (
          <>
            {current.path && !editing && (
              <p
                title={current.path}
                className="font-mono text-[11px] text-muted-foreground/80 truncate mb-4 select-text"
              >
                {current.path}
              </p>
            )}
            {editing ? (
              <div className="min-w-0 flex-1">
                <CodeMirrorEditor
                  ref={editorRef}
                  value={draft}
                  onChange={setDraft}
                  onSave={() => {}}
                  onToggleMode={() => setEditing(false)}
                  onAiContinue={() => {}}
                  onCancel={() => setEditing(false)}
                  onImageFile={() => {}}
                  ghostText=""
                  onGhostAccept={() => {}}
                  onGhostDismiss={() => {}}
                  autoFocus
                  placeholder={t('mdEditor.placeholder')}
                />
              </div>
            ) : (
              <ChatMarkdown content={currentContent} proseClass="reading-prose" />
            )}
          </>
        ) : (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Eye className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">
              {t('preview.emptyTitle')}
            </h3>
            <p className="text-[13px] text-muted-foreground max-w-[320px] leading-relaxed">
              {t('preview.emptyDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
