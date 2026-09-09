/**
 * 文档头「来源文件」：vault 文档显示相对 vault 根的路径（V-402）。
 *
 * `vault_path` 只有 vault notebook 的文档才有；db notebook 传 null 时不渲染任何东西。
 */
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { CopyButton } from './ui'

export default function DocVaultPath({ path }: { path: string | null }) {
  const { t } = useTranslation()
  if (!path) return null

  return (
    <div className="mt-2 flex items-center gap-1.5 min-w-0 text-sm text-muted-foreground/70 print:hidden">
      <FileText className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
      <span className="shrink-0">{t('doc.vaultPathLabel')}</span>
      <code className="truncate font-mono" title={path}>
        {path}
      </code>
      <CopyButton
        text={path}
        ariaLabel={t('doc.copyVaultPath')}
        title={t('doc.copyVaultPath')}
        className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
      />
    </div>
  )
}
