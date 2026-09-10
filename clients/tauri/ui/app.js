// 最小启动页：拉起内嵌 engine（Rust 侧 spawn + NF_READY 握手），
// 拿到入口 URL 后整页跳转——此后整个应用就是 engine 自带的 web-dist UI（?native=tauri 壳模式）。
//
// vault 入口（V-403）：选文件夹 → Rust 侧以 `--vault-path` + `--app-support-dir` 重启 engine
// （DATA_DIR 由 engine 按 sha256 派生），拿到新入口 URL 后同样整页跳转。
//
// 首次启动（壳侧没记住模式）：**不自动跳转**，强制用户先选「笔记文件夹」或「先用数据库模式」。
// 选过之后模式记在壳侧（active-mode.json），以后启动直接进对应模式——否则每次都回 db 模式，
// 用户会以为自己的笔记丢了，而文件夹里的外部改动也永远不会出现在应用里。
//
// 闪烁对策：engine 很快就绪时也不要立刻跳走——给 logo 动画留足时间，
// 淡出后再 replace；否则会看到「启动页闪一下 → 空白 → React 冒出」。
applySplashTheme()

const msg = document.getElementById('msg')

;(async () => {
  const MIN_SPLASH_MS = 1400
  const FADE_MS = 320
  const boot = document.getElementById('boot')
  const t0 = performance.now()

  try {
    // 首次启动（没记住模式）：停在启动页让用户选，不启动 engine、不跳转
    const state = await readModeState()
    if (state && !state.mode) {
      await renderFirstRun(state)
      return
    }

    const info = await window.__TAURI__.core.invoke('engine_start')
    // engine 就绪后再渲染 vault 入口：避免与 engine_start 抢句柄（切 vault 要先停旧实例）
    await initVaultEntry()

    // 冷启动双击 .md：Rust 后台导入完成后会直接跳文档/收集箱页，
    // splash 停留等它，避免「先看到文档列表、再跳目标页」的闪烁。
    if (await shouldHoldForImport()) {
      msg.textContent = '正在打开文档…'
      await alignWebviewToAppBg()
      // 不 replace：跳转由 import 完成后的 win.eval 驱动；失败兜底也会跳首页
      return
    }

    const wait = Math.max(0, MIN_SPLASH_MS - (performance.now() - t0))
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))

    // 启动等待期间又双击了文件 / 点了 vault：让出跳转权，避免 replace 盖掉目标页
    if (await shouldHoldForImport()) {
      msg.textContent = '正在打开文档…'
      await alignWebviewToAppBg()
      return
    }

    // 跳转前把 webview 底色对齐主 UI tokens（亮 #fff / 暗 #191919），
    // 减少 replace 后、React 挂载前露出 splash 色或 conf 默认色。
    await alignWebviewToAppBg()

    boot.classList.add('out')
    await new Promise((r) => setTimeout(r, FADE_MS))

    if (window.__nfImported || window.__nfVaultBusy || (await shouldHoldForImport())) return

    window.location.replace(info.url)
  } catch (err) {
    msg.remove()
    const el = document.createElement('div')
    el.className = 'err'
    el.textContent = `engine 启动失败：${err}`
    boot.appendChild(el)
  }
})()

// ── 模式（首次启动 / 已记住）────────────────────────────────────────────────────

/** 壳侧记住的启动模式；调用失败返回 null（当作「已决定」，走原来的启动流程） */
async function readModeState() {
  try {
    return await window.__TAURI__.core.invoke('mode_state')
  } catch {
    return null
  }
}

const FIRST_RUN_HINT = '选择一个文件夹作为笔记库：里面的 Markdown 就是你的笔记，' +
  'NoteFast 会为它建索引，编辑也会写回这些文件。'

/** 首次启动：标题改为让用户选，并给出「选文件夹」与「先用数据库模式」两个出口 */
async function renderFirstRun(state) {
  const box = document.getElementById('vault')
  const pick = document.getElementById('vault-pick')
  const dbBtn = document.getElementById('vault-db')

  box.hidden = false
  pick.textContent = '选择笔记文件夹…'
  pick.classList.add('primary')
  dbBtn.hidden = false
  msg.classList.add('hint')
  msg.textContent = FIRST_RUN_HINT
  const restoreHint = () => {
    msg.textContent = FIRST_RUN_HINT
  }

  pick.addEventListener('click', () => {
    openVault(() => window.__TAURI__.core.invoke('vault_pick_and_open'), restoreHint)
  })
  dbBtn.addEventListener('click', () => {
    openVault(() => window.__TAURI__.core.invoke('use_db_mode'), restoreHint)
  })

  for (const path of (state.recent || []).slice(0, 3)) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = basename(path)
    btn.title = path
    btn.addEventListener('click', () => {
      openVault(() => window.__TAURI__.core.invoke('vault_open', { path }))
    })
    box.appendChild(btn)
  }
}

// ── vault 入口 ────────────────────────────────────────────────────────────────

/** 渲染「打开文件夹为 vault…」+ 最近 vault（壳侧记忆，最多 3 条） */
async function initVaultEntry() {
  const box = document.getElementById('vault')
  if (!box || !window.__TAURI__?.core?.invoke) return
  box.hidden = false

  document.getElementById('vault-pick').addEventListener('click', () => {
    openVault(() => window.__TAURI__.core.invoke('vault_pick_and_open'))
  })

  try {
    const recent = await window.__TAURI__.core.invoke('vault_recent')
    for (const path of (recent || []).slice(0, 3)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = basename(path)
      btn.title = path
      btn.addEventListener('click', () => {
        openVault(() => window.__TAURI__.core.invoke('vault_open', { path }))
      })
      box.appendChild(btn)
    }
  } catch {
    /* 最近列表读不到不影响选文件夹 */
  }
}

/** 让出 splash 的自动跳转，等 Rust 侧切到 vault 模式后整页跳新入口。
 *  `onCancel`：用户取消选择时的复原动作（首次启动的必选流程要回到提示文案）。 */
async function openVault(run, onCancel) {
  window.__nfVaultBusy = true
  msg.textContent = '正在打开 vault…'
  try {
    const info = await run()
    if (!info || !info.url) {
      // 用户取消选择：放开跳转权，splash 继续原来的流程
      window.__nfVaultBusy = false
      if (onCancel) onCancel()
      else msg.textContent = '正在启动 NoteFast'
      return
    }
    await alignWebviewToAppBg()
    window.location.replace(info.url)
  } catch (err) {
    window.__nfVaultBusy = false
    msg.textContent = `打开 vault 失败：${err}`
  }
}

function basename(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(path)
}

async function shouldHoldForImport() {
  if (window.__nfImported) return true
  try {
    return await window.__TAURI__.core.invoke('has_pending_open_files')
  } catch {
    return false
  }
}

async function readThemePref() {
  try {
    return await window.__TAURI__.core.invoke('ui_theme_pref')
  } catch {
    return null
  }
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveDark(pref) {
  if (pref === 'light') return false
  if (pref === 'dark') return true
  return systemPrefersDark()
}

/** 立刻按 ui-preferences 设 splash data-theme，避免只跟系统 */
async function applySplashTheme() {
  const dark = resolveDark(await readThemePref())
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

/** 跳转前底色跟设置（light/dark）或系统；不再只信 prefers-color-scheme */
async function alignWebviewToAppBg() {
  const dark = resolveDark(await readThemePref())
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
