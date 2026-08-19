import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export interface DocNeighbor {
  id: string
  title: string
}

/** 正文末尾：按创建顺序的上一篇 / 下一篇（带标题，避免理解成「返回」） */
export default function DocNeighborPager({
  prev,
  next,
}: {
  prev: DocNeighbor | null
  next: DocNeighbor | null
}) {
  const { t } = useTranslation()
  if (!prev && !next) return null

  return (
    <nav
      className="mt-16 pt-8 border-t border-border/50 grid grid-cols-2 gap-6"
      aria-label={t('doc.neighborNav')}
    >
      <div className="min-w-0">
        {prev ? (
          <Link
            to={`/doc/${prev.id}`}
            className="group block min-w-0 rounded-md -m-2 p-2 hover:bg-accent/50 transition-colors"
          >
            <div className="text-[11px] text-muted-foreground/80 mb-1">{t('doc.prevDocLabel')}</div>
            <div className="text-[13.5px] font-medium text-foreground truncate group-hover:text-foreground">
              {prev.title || t('doc.untitledDocument')}
            </div>
          </Link>
        ) : (
          <div className="text-[12px] text-muted-foreground/50">{t('doc.noPrevDoc')}</div>
        )}
      </div>
      <div className="min-w-0 text-right">
        {next ? (
          <Link
            to={`/doc/${next.id}`}
            className="group block min-w-0 rounded-md -m-2 p-2 hover:bg-accent/50 transition-colors"
          >
            <div className="text-[11px] text-muted-foreground/80 mb-1">{t('doc.nextDocLabel')}</div>
            <div className="text-[13.5px] font-medium text-foreground truncate">
              {next.title || t('doc.untitledDocument')}
            </div>
          </Link>
        ) : (
          <div className="text-[12px] text-muted-foreground/50">{t('doc.noNextDoc')}</div>
        )}
      </div>
    </nav>
  )
}
