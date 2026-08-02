import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

/** 子页顶部面包屑：设置 / {section} */
export default function SettingsSubHeader({ section }: { section: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80">
      <Link to="/settings" className="hover:text-foreground transition-colors">{t('settingsSub.settings')}</Link>
      <span>/</span>
      <span className="text-muted-foreground">{section}</span>
    </div>
  )
}
