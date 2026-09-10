/**
 * 「vault 是唯一形态」的引导页（RFC 0006）
 *
 * 背景：vault 现在是唯一受支持的数据形态；`db` 模式只剩两种情况——
 * 1. **0.90 之前的旧库**：SQLite 里有笔记，但磁盘上没有对应文件
 * 2. **新装还没指定文件夹**：库是空的
 *
 * 这里只做**提示**：不自动迁移、不删数据、不动用户文件。旧库给「导出 zip + 迁移三步」，
 * 空库给「各部署方式怎么指定文件夹」，并留一个「暂时继续用数据库模式」的出口
 * （Docker 没有挂载文件夹的人不该被挡住）。
 *
 * 纯展示组件：判定与 dismiss 状态在 `useVaultSetupGate`，便于 SSR 单测。
 */
import { useTranslation } from 'react-i18next'
import { FolderTree, HardDriveDownload } from 'lucide-react'
import { Button } from './ui'

export interface VaultSetupNoticeProps {
  /** db 模式下的活文档数：> 0 = 旧库有数据，0 = 空库 */
  docCount: number
  /** 导出旧笔记（zip）；不传则不渲染该按钮 */
  onExport?: () => void
  /** 暂时继续用数据库模式 */
  onDismiss: () => void
  exporting?: boolean
}

export default function VaultSetupNotice({
  docCount,
  onExport,
  onDismiss,
  exporting = false,
}: VaultSetupNoticeProps) {
  const { t } = useTranslation()
  const legacy = docCount > 0

  return (
    <div className="min-h-dvh w-full flex items-center justify-center px-6 py-12 bg-background">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-muted/70 text-foreground/70 grid place-items-center shrink-0">
            <FolderTree className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h1 className="text-h2 font-bold tracking-[-0.02em] text-foreground">
              {t('vaultSetup.title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {legacy
                ? t('vaultSetup.legacySubtitle', { n: docCount })
                : t('vaultSetup.freshSubtitle')}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-base text-foreground leading-relaxed">
            {legacy ? t('vaultSetup.legacyIntro') : t('vaultSetup.freshIntro')}
          </p>

          <ol className="space-y-2 text-base text-muted-foreground leading-relaxed list-decimal pl-5">
            {(legacy
              ? (['step1', 'step2', 'step3'] as const)
              : (['fresh1', 'fresh2', 'fresh3'] as const)
            ).map((key) => (
              <li key={key}>{t(`vaultSetup.${key}`)}</li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {legacy && onExport && (
              <Button
                variant="primary"
                size="sm"
                loading={exporting}
                data-vault-setup="export"
                icon={<HardDriveDownload className="w-4 h-4" strokeWidth={1.75} />}
                onClick={onExport}
              >
                {t('vaultSetup.exportNow')}
              </Button>
            )}
            <a
              href="https://github.com/atbeta/notefast/blob/main/docs/vault-migration.md"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4"
            >
              {t('vaultSetup.guideLink')}
            </a>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {legacy ? t('vaultSetup.legacyKeepHint') : t('vaultSetup.freshKeepHint')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-vault-setup="dismiss"
            onClick={onDismiss}
          >
            {t('vaultSetup.keepDbMode')}
          </Button>
        </div>
      </div>
    </div>
  )
}
