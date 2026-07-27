import SettingsSubHeader from '../components/SettingsSubHeader'
import ApiTokensPanel from '../components/ApiTokensPanel'

export default function SettingsTokensPage() {
  return (
    <div className="w-full max-w-4xl mx-auto px-8 py-10 space-y-7 animate-fade-in">
      <header className="space-y-3">
        <SettingsSubHeader section="API Token" />
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">已授权的 API Token</h1>
          <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5">
            为外部工具、MCP 客户端或脚本创建独立 Token，支持读写权限拆分与独立撤销。
          </p>
        </div>
      </header>

      <ApiTokensPanel />
    </div>
  )
}
