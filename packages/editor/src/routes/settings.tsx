/** 设置路由：NoteFast URL + token + 关于（M5 接入自动发现 + 手动配置）。 */
export default function SettingsView() {
  return (
    <main className="flex min-h-screen flex-col p-8">
      <h1 className="text-xl font-semibold">设置</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        NoteFast 地址与 Token 配置（M5 接入自动发现与手动配置）。
      </p>
    </main>
  )
}
