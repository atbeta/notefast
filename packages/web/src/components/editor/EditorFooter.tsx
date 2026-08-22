import { useTranslation } from 'react-i18next'
import { FilePlus2, Loader2, Check, AlertTriangle } from 'lucide-react'
import { currentLocale } from '../../lib/time'
import { Tooltip } from '../ui'

interface EditorFooterProps {
  charCount: number
  lines: number
  readMin: number
  dirty: boolean
  draftedAt: Date | null
  hasDraft: boolean
  onClearDraft: () => void
  onAppendFile?: (text: string) => void
  relativeTime: (date: Date | null) => string
  autoSaveStatus: 'idle' | 'saving' | 'saved' | 'error'
}

export default function EditorFooter({
  charCount,
  lines,
  readMin,
  dirty,
  draftedAt,
  hasDraft,
  onClearDraft,
  onAppendFile,
  relativeTime,
  autoSaveStatus,
}: EditorFooterProps) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground/70 tabular-nums">
      <span>
        {t('editorFooter.stats', {
          chars: charCount.toLocaleString(currentLocale()),
          lines: lines.toLocaleString(currentLocale()),
          minutes: readMin,
        })}
      </span>

      <span className="flex items-center gap-1">
        {autoSaveStatus === 'saving' ? (
          <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
        ) : autoSaveStatus === 'saved' ? (
          <Check className="w-3 h-3 text-success" strokeWidth={1.75} />
        ) : autoSaveStatus === 'error' ? (
          <AlertTriangle className="w-3 h-3 text-warning" strokeWidth={1.75} />
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full ${dirty ? 'bg-warning' : 'bg-border'}`} />
        )}
        {autoSaveStatus === 'saving'
          ? t('editorFooter.autoSaving')
          : autoSaveStatus === 'saved'
          ? t('editorFooter.autoSaved')
          : autoSaveStatus === 'error'
          ? t('editorFooter.autoSaveFailed')
          : dirty
          ? draftedAt
            ? t('editorFooter.unsavedDraft', { time: relativeTime(draftedAt) })
            : t('editorFooter.unsaved')
          : t('editorFooter.upToDate')}
      </span>

      <span className="ml-auto flex items-center gap-1">
        {hasDraft && (
          <Tooltip label={t('editorFooter.discardDraftTitle')}>
            <button
              type="button"
              onClick={onClearDraft}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-muted-foreground/80 hover:text-destructive transition-colors"
            >
              <Loader2 className="w-3 h-3" strokeWidth={1.75} />
              {t('editorFooter.discardDraft')}
            </button>
          </Tooltip>
        )}
        {onAppendFile && (
          <Tooltip label={t('editorFooter.appendFileTitle')}>
            <button
              type="button"
              onClick={() => {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = '.md,.markdown,.txt'
                input.onchange = async () => {
                  const file = input.files?.[0]
                  if (!file) return
                  const text = await file.text()
                  onAppendFile('\n\n' + text + '\n\n')
                }
                input.click()
              }}
              aria-label={t('editorFooter.appendFile')}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground/80 hover:text-foreground hover:bg-accent transition-colors"
            >
              <FilePlus2 className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  )
}
