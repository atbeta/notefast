// 最小启动页：拉起内嵌 engine（Rust 侧 spawn + NF_READY 握手），
// 拿到入口 URL 后整页跳转——此后整个应用就是 engine 自带的 web-dist UI（?native=tauri 壳模式）。
;(async () => {
  const msg = document.getElementById('msg')
  const boot = document.getElementById('boot')
  try {
    const info = await window.__TAURI__.core.invoke('engine_start')
    window.location.replace(info.url)
  } catch (err) {
    msg.remove()
    const el = document.createElement('div')
    el.className = 'err'
    el.textContent = `engine 启动失败：${err}`
    boot.appendChild(el)
  }
})()
