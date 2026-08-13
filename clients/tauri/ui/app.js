// 最小启动页：拉起内嵌 engine（Rust 侧 spawn + NF_READY 握手），
// 拿到入口 URL 后整页跳转——此后整个应用就是 engine 自带的 web-dist UI（?native=tauri 壳模式）。
//
// 闪烁对策：engine 很快就绪时也不要立刻跳走——给 logo 动画留足时间，
// 淡出后再 replace；否则会看到「启动页闪一下 → 空白 → React 冒出」。
;(async () => {
  const MIN_SPLASH_MS = 1400
  const FADE_MS = 320
  const msg = document.getElementById('msg')
  const boot = document.getElementById('boot')
  const t0 = performance.now()

  try {
    const info = await window.__TAURI__.core.invoke('engine_start')

    // 冷启动双击 .md：Rust 后台导入完成后会直接跳文档/收集箱页，
    // splash 停留等它，避免「先看到文档列表、再跳目标页」的闪烁。
    const pending = await window.__TAURI__.core.invoke('has_pending_open_files')
    if (pending) {
      msg.textContent = '正在打开文档…'
      await alignWebviewToAppBg()
      // 不 replace：跳转由 import 完成后的 win.eval 驱动；失败兜底也会跳首页
      return
    }

    const wait = Math.max(0, MIN_SPLASH_MS - (performance.now() - t0))
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))

    // 跳转前把 webview 底色对齐主 UI tokens（亮 #fff / 暗 #191919），
    // 减少 replace 后、React 挂载前露出 splash 色或 conf 默认色。
    await alignWebviewToAppBg()

    boot.classList.add('out')
    await new Promise((r) => setTimeout(r, FADE_MS))

    window.location.replace(info.url)
  } catch (err) {
    msg.remove()
    const el = document.createElement('div')
    el.className = 'err'
    el.textContent = `engine 启动失败：${err}`
    boot.appendChild(el)
  }
})()

/** 系统主题近似主 UI 底色；theme 存在 engine origin localStorage，启动页读不到 */
async function alignWebviewToAppBg() {
  const dark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  const [r, g, b] = dark ? [25, 25, 25] : [255, 255, 255]
  const color = { red: r, green: g, blue: b, alpha: 255 }
  document.body.style.background = `rgb(${r},${g},${b})`
  try {
    const win = window.__TAURI__.window.getCurrentWindow()
    await win.setBackgroundColor(color)
  } catch {
    /* 窗口 API 不可用时回退 webview */
  }
  try {
    const wv = window.__TAURI__.webview.getCurrentWebview()
    await wv.setBackgroundColor(color)
  } catch {
    /* 权限 / API 缺失时仍靠 body 色过渡 */
  }
}
