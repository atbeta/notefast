import SettingsSubHeader from '../components/SettingsSubHeader'
import SyncPanel from '../components/SyncPanel'

export default function SettingsSyncPage() {
  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-7 animate-fade-in">
      <header className="space-y-3">
        <SettingsSubHeader section="Markdown 归档" />
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">Markdown 归档（单向）</h1>
          <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5">
            将文档导出为 Markdown 推送到单一远端（LocalFS / S3 / WebDAV）。这是内容归档，不是完整数据库备份；
            不含 block ID、引用、标签与向量。
          </p>
        </div>
      </header>

      <SyncPanel />
    </div>
  )
}
