import { Undo2, Redo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from './ui'
import { useNavHistory } from '../hooks/useNavHistory'

/** 文档顶栏：访问历史后退/前进（不是按创建顺序翻篇） */
export default function DocVisitNav() {
  const { t } = useTranslation()
  const { canBack, canForward, back, forward, goBack, goForward } = useNavHistory()
  const backLabel = canBack && back
    ? t('doc.navBack', { title: back.label })
    : t('doc.navNoBack')
  const forwardLabel = canForward && forward
    ? t('doc.navForward', { title: forward.label })
    : t('doc.navNoForward')

  return (
    <div className="flex items-center gap-1">
      <Tooltip label={backLabel}>
        <button
          type="button"
          onClick={goBack}
          disabled={!canBack}
          className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label={backLabel}
        >
          <Undo2 className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </Tooltip>
      <Tooltip label={forwardLabel}>
        <button
          type="button"
          onClick={goForward}
          disabled={!canForward}
          className="btn-icon-ghost text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label={forwardLabel}
        >
          <Redo2 className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  )
}
