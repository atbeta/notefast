import { useEffect, useState } from 'react'
import { loadSettings, saveSettings } from '../lib/settings'

/** 设置路由：NoteFast URL + token（M2 手动配置，M5 加自动发现）。 */
export default function SettingsView() {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const s = loadSettings()
    setUrl(s.noteFastUrl)
    setToken(s.apiToken)
  }, [])

  const handleSave = () => {
    saveSettings({ noteFastUrl: url, apiToken: token })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-8">
      <h1 className="text-xl font-semibold">设置</h1>

      <section className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">NoteFast 地址</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:3140"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            本机运行 NoteFast 的地址；留空则「导入到 NoteFast」不可用。
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">API Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer Token（免鉴权实例留空）"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <button
          type="button"
          className="rounded-md bg-ink px-4 py-2 text-sm text-ink-foreground hover:bg-ink-hover"
          onClick={handleSave}
        >
          {saved ? '已保存' : '保存'}
        </button>
      </section>
    </main>
  )
}
