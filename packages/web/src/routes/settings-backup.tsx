import SettingsSubHeader from '../components/SettingsSubHeader'
import BackupPanel from '../components/BackupPanel'

export default function SettingsBackupPage() {
  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-7 animate-fade-in">
      <header className="space-y-3">
        <SettingsSubHeader section="数据库备份" />
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">数据库备份 (SQLite → S3)</h1>
          <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5">
            在线生成一致 SQLite 快照并上传到 S3 兼容存储。默认每小时一次、保留 30 天；
            恢复需先停止服务，再通过 CLI 触发（不在 Web 内提供一键覆盖）。
          </p>
        </div>
      </header>

      <BackupPanel />
    </div>
  )
}
