//! NoteFast Windows 桌面客户端（Tauri 壳）
//!
//! 壳层职责：内嵌 engine 进程生命周期管理 + 最小启动页跳转。
//! 业务（block 模型/检索/AI/MCP/同步）全部复用 server engine，壳层不重写。

mod engine;
mod import;
mod ui_theme;
mod vault;

use engine::{EngineHandle, EngineInfo, LaunchMode};
use vault::ActiveMode;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 全局 engine 句柄（同一时刻只有一个内嵌实例）
struct EngineState(Mutex<Option<EngineHandle>>);

/// 冷启动是否带入 .md 待打开文件：splash 据此决定停留等导入（而非先跳文档列表）。
/// 用独立标志而非直接查 argv——setup 后 argv 不再可得，且 single_instance 回调的
/// 第二实例 argv 不应影响已运行实例的启动页行为。
struct PendingOpenFiles(Mutex<bool>);

#[tauri::command]
fn has_pending_open_files(state: State<'_, PendingOpenFiles>) -> bool {
    state.0.lock().map(|g| *g).unwrap_or(false)
}

/// 读 data/ui-preferences.json 的 theme；文件不存在或非法则 null（启动页跟系统）。
#[tauri::command]
fn ui_theme_pref(app: AppHandle) -> Option<String> {
    default_data_dir(&app)
        .ok()
        .and_then(|dir| ui_theme::read_theme_pref(&dir))
}

/// 启动内嵌 engine 并返回入口信息；已运行则直接返回既有实例（幂等）。
/// 阻塞握手放线程池执行，避免卡住主线程/UI。
#[tauri::command]
async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<EngineInfo, String> {
    {
        let mut guard = state.0.lock().map_err(|_| "engine state 锁被污染".to_string())?;
        if let Some(handle) = guard.as_mut() {
            if handle.is_alive() {
                return Ok(handle.info.clone());
            }
        }
    }
    let data_dir = default_data_dir(&app)?;
    // 上次选过的模式优先：不记的话每次启动都回 db 模式，用户会以为自己的笔记丢了
    let mode = match vault::read_mode(&data_dir) {
        Some(ActiveMode::Vault { vault_path }) => LaunchMode::Vault {
            vault_path: PathBuf::from(vault_path),
            app_support_dir: app_support_dir(&app)?,
        },
        _ => LaunchMode::DataDir(data_dir),
    };
    launch(&app, mode).await
}

/// 启动页据此决定：直接启动（mode 已定）还是**强制**先让用户选文件夹（mode = null）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeState {
    /// "vault" | "db" | null（null = 首次启动，或上次记的文件夹已不可用）
    mode: Option<String>,
    vault_path: Option<String>,
    recent: Vec<String>,
}

#[tauri::command]
fn mode_state(app: AppHandle) -> ModeState {
    let data_dir = default_data_dir(&app).ok();
    let mode = data_dir.as_deref().and_then(vault::read_mode);
    ModeState {
        mode: match &mode {
            Some(ActiveMode::Vault { .. }) => Some("vault".to_string()),
            Some(ActiveMode::Db) => Some("db".to_string()),
            None => None,
        },
        vault_path: match &mode {
            Some(ActiveMode::Vault { vault_path }) => Some(vault_path.clone()),
            _ => None,
        },
        recent: data_dir.map(|d| vault::read(&d)).unwrap_or_default(),
    }
}

/// 首次启动选「先用数据库模式」/ 从 vault 回到数据库模式：记住并（重）起 db 实例
#[tauri::command]
async fn use_db_mode(app: AppHandle) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = default_data_dir(&app)?;
        vault::write_mode(&data_dir, &ActiveMode::Db)?;
        stop_engine(&app);
        start_and_store(&app, LaunchMode::DataDir(data_dir))
    })
    .await
    .map_err(|e| format!("切换数据库模式失败: {e}"))?
}

/// 同步启动（阻塞握手）并写入 EngineState；调用方负责放线程池。
fn start_and_store(app: &AppHandle, mode: LaunchMode) -> Result<EngineInfo, String> {
    let engine_dir = resolve_engine_dir(app)?;
    let started = engine::start(&engine_dir, mode)?;
    let info = started.info.clone();
    *app.state::<EngineState>()
        .0
        .lock()
        .map_err(|_| "engine state 锁被污染".to_string())? = Some(started);
    Ok(info)
}

/// 启动（或重启）engine，成功后写入 EngineState。mode 决定 --data-dir / --vault-path。
async fn launch(app: &AppHandle, mode: LaunchMode) -> Result<EngineInfo, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || start_and_store(&app, mode))
        .await
        .map_err(|e| format!("engine 启动任务失败: {e}"))?
}

/// 停掉当前 engine（优雅停机；无实例时是 no-op）。阻塞，调用方放线程池。
fn stop_engine(app: &AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut handle) = guard.take() {
                handle.stop();
            }
        }
    }
}

/// 应用支持目录：每 vault 索引的父目录（engine 派生 `<本目录>/<sha256 前 12 位>`）。
/// 便携模式 = exe 所在目录；安装版 = `%APPDATA%/com.notefast.desktop`（与 macOS 壳
/// `~/Library/Application Support/NoteFast` 对应）。
fn app_support_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        if exe_dir.join(PORTABLE_MARKER).is_file() {
            return Ok(exe_dir);
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用支持目录: {e}"))
}

// ───────────────────────── vault（打开文件夹为 vault，V-403）─────────────────────────

/// 最近打开的 vault（壳侧记忆，最新在前）
#[tauri::command]
fn vault_recent(app: AppHandle) -> Vec<String> {
    default_data_dir(&app).map(|d| vault::read(&d)).unwrap_or_default()
}

/// 弹系统文件夹选择框，选中后以 vault 模式重启 engine；用户取消返回 null
#[tauri::command]
async fn vault_pick_and_open(app: AppHandle) -> Result<Option<EngineInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("打开文件夹为 vault")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = folder
            .into_path()
            .map_err(|e| format!("无法解析所选文件夹: {e}"))?;
        open_vault(&app, &path).map(Some)
    })
    .await
    .map_err(|e| format!("vault 切换任务失败: {e}"))?
}

/// 以 vault 模式打开指定文件夹（启动页的最近列表走这里，不再弹框）
#[tauri::command]
async fn vault_open(app: AppHandle, path: String) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || open_vault(&app, Path::new(&path)))
        .await
        .map_err(|e| format!("vault 切换任务失败: {e}"))?
}

/// 以 vault 模式打开文件夹（阻塞）：校验 → 记最近列表 → 停旧实例 → 起新实例。
/// DATA_DIR 由 engine 派生，壳只传文件夹与应用支持目录。
fn open_vault(app: &AppHandle, path: &Path) -> Result<EngineInfo, String> {
    if !path.is_dir() {
        // 文件夹被删 / 移动：从最近列表里清掉，避免启动页一直挂着一条打不开的条目
        if let Ok(data_dir) = default_data_dir(app) {
            vault::forget(&data_dir, &path.to_string_lossy());
        }
        return Err(format!("文件夹不可用: {}", path.display()));
    }
    let data_dir = default_data_dir(app)?;
    vault::remember(&data_dir, &path.to_string_lossy());
    // 记住模式：下次启动直接回到这个文件夹（否则又回 db 模式 = 像数据丢了）
    vault::write_mode(
        &data_dir,
        &ActiveMode::Vault { vault_path: path.to_string_lossy().to_string() },
    )?;

    stop_engine(app);
    let mode = LaunchMode::Vault {
        vault_path: path.to_path_buf(),
        app_support_dir: app_support_dir(app)?,
    };
    start_and_store(app, mode)
}

/// 启动页/单实例回调共用的「选文件夹 → 开 vault」入口（失败只记日志）
fn pick_and_open_vault(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let picked = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            move || {
                app.dialog()
                    .file()
                    .set_title("打开文件夹为 vault")
                    .blocking_pick_folder()
            }
        })
        .await
        .ok()
        .flatten();
        let Some(folder) = picked else { return };
        let Ok(path) = folder.into_path() else { return };
        let result = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            move || open_vault(&app, &path)
        })
        .await;
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => eprintln!("[notefast] 打开 vault 失败: {e}"),
            Err(e) => eprintln!("[notefast] 打开 vault 任务失败: {e}"),
        }
    });
}

/// 定位 engine 产物目录，优先级：
/// 1. `NOTEFAST_ENGINE_DIR` 显式指定（与 macOS 壳同约定）
/// 2. debug 构建自动探测仓库内 `packages/server/dist-engine`（dev 免配置）
/// 3. 打包模式取资源目录 `resources/engine/`
fn resolve_engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("NOTEFAST_ENGINE_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }

    // dev 免配置：CARGO_MANIFEST_DIR = src-tauri，向上三级即仓库根
    #[cfg(debug_assertions)]
    {
        let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("server")
            .join("dist-engine");
        if candidate.join(engine::engine_binary_name()).exists() {
            return Ok(candidate);
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法定位资源目录: {e}"))?;
    let dir = resource_dir.join("engine");
    if dir.join(engine::engine_binary_name()).exists() {
        return Ok(dir);
    }
    Err(format!(
        "找不到 engine 产物。dev 模式请先运行 `bun run build:engine` 产出 \
         packages/server/dist-engine（或设置 NOTEFAST_ENGINE_DIR 覆盖）；\
         打包模式请将 engine 产物放入 resources/engine/（已尝试: {}）",
        dir.display()
    ))
}

/// 便携模式标记文件：存在于 exe 父目录时启用。发布便携版 zip 时手动用空文件填入，
/// 不存在则认为是 NSIS 安装版（走 AppData）。
const PORTABLE_MARKER: &str = "notefast-portable";

/// 第二实例参数：不重启应用，直接弹「打开文件夹为 vault」选择框
const VAULT_PICKER_FLAG: &str = "--vault-picker";

/// 数据目录（普通 db notebook）：
/// - 便携模式（exe 同目录存在 `notefast-portable`）→ `<exe 父目录>/data`，整个文件夹复制走即可
/// - NSIS 安装模式 → `%APPDATA%/com.notefast.desktop/data`（macOS 壳同理）
/// - `NOTEFAST_DATA_DIR` 环境变量可覆盖（CI / 自定义部署）
///
/// vault 模式的索引目录不在这里，由 engine 派生到 `app_support_dir`（见上）。
fn default_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("NOTEFAST_DATA_DIR") {
        let custom = custom.trim();
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    Ok(app_support_dir(app)?.join("data"))
}

pub fn run() {
    // 打开即导入·冷启动：Windows 文件关联双击 → 以文件路径为 argv 拉起新实例
    let initial_files: Vec<PathBuf> = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| import::is_markdown_path(p) && p.is_file())
        .collect();

    tauri::Builder::default()
        // 单实例：第二个实例直接退出并聚焦已有窗口——多开会共享同一 data 目录，
        // 配置文件并发写互相覆盖、索引/同步双跑
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // 已运行时双击 .md：第二实例 argv 带文件路径 → 打开即导入
            // （is_initial=false：应用已运行，导入完成后延时跳转即可，不改变启动页行为）
            let files: Vec<PathBuf> = args
                .iter()
                .map(PathBuf::from)
                .filter(|p| import::is_markdown_path(p) && p.is_file())
                .collect();
            // 启动页可能还在倒计时 replace：标 pending，让 splash 让出跳转权
            if !files.is_empty() {
                if let Some(state) = app.try_state::<PendingOpenFiles>() {
                    if let Ok(mut g) = state.0.lock() {
                        *g = true;
                    }
                }
            }
            // `NoteFast.exe --vault-picker`（第二实例）：不重启应用，直接弹 vault 选择框。
            // 补启动页那 1.4s 窗口不易点中的问题——用户可把该参数做成快捷方式。
            if args.iter().any(|a| a == VAULT_PICKER_FLAG) {
                pick_and_open_vault(app);
            }
            import::handle_open_files(app, files, false);
        }))
        // 保存对话框 + 文件写入：前端导出 markdown/zip 时让用户选位置（而非静默下载到 Downloads）
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 外链：WebView2 默认吞掉 target=_blank；插件拦截后用系统浏览器打开
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState(Mutex::new(None)))
        // 冷启动带入文件才置位；single_instance 第二实例导入不影响
        .manage(PendingOpenFiles(Mutex::new(!initial_files.is_empty())))
        .invoke_handler(tauri::generate_handler![
            engine_start,
            has_pending_open_files,
            ui_theme_pref,
            vault_recent,
            vault_pick_and_open,
            vault_open,
            use_db_mode,
            mode_state,
        ])
        .setup(move |app| {
            // 启动闪屏：conf 里 visible=false。light/dark 用 ui-preferences；
            // 未设或 system 才跟 OS。色值对齐 ui/index.html 的 --bg。
            if let Some(win) = app.get_webview_window("main") {
                // Windows WebView2 的「Suggestions」自动填充无视 autocomplete 属性，
                // 标题/搜索框仍弹历史下拉。在 WebView2 设置层全局关掉通用自动填充
                // （IsGeneralAutofillEnabled=false），web 侧 autocomplete 标记只兜底其余引擎。
                #[cfg(windows)]
                let _ = win.with_webview(|webview| {
                    unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
                        use windows_core::Interface;
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() {
                                    let _ = settings4.SetIsGeneralAutofillEnabled(false);
                                }
                            }
                        }
                    }
                });
                let system_dark = !matches!(win.theme(), Ok(tauri::Theme::Light));
                let choice = default_data_dir(app.handle())
                    .ok()
                    .and_then(|dir| ui_theme::read_theme_pref(&dir));
                let is_dark = ui_theme::startup_is_dark(choice.as_deref(), system_dark);
                let (r, g, b) = ui_theme::splash_rgb(is_dark);
                let _ = win.set_background_color(Some(tauri::webview::Color::from((r, g, b, 255))));
                let theme_attr = if is_dark { "dark" } else { "light" };
                let _ = win.eval(&format!(
                    "document.documentElement.setAttribute('data-theme','{theme_attr}')"
                ));
                let _ = win.show();
            }
            // 冷启动带入的 .md：engine 由前端启动页拉起，import 内部会等它就绪。
            // is_initial=true：splash 会停留等导入完成，避免先闪现文档列表
            if !initial_files.is_empty() {
                import::handle_open_files(app.handle(), initial_files.clone(), true);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // 窗口就位后：初始尺寸超屏则收缩到显示器内。
                // width/height 是逻辑像素，Windows 150% 缩放下 1200×800 → 物理 1800×1200，
                // 超出 1920×1080 屏幕（setup 阶段 current_monitor 可能为 None，故放这里）
                tauri::RunEvent::Ready => {
                    if let Some(win) = app.get_webview_window("main") {
                        if let (Ok(Some(monitor)), Ok(outer)) = (win.current_monitor(), win.outer_size()) {
                            let mon = monitor.size();
                            if outer.width > mon.width || outer.height > mon.height {
                                // 收缩到显示器物理尺寸的 90%×85%（下方留任务栏余量）
                                let w = ((mon.width as f64 * 0.9) as u32).max(800);
                                let h = ((mon.height as f64 * 0.85) as u32).max(600);
                                let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w, h)));
                            }
                        }
                    }
                }
                // 退出链路：先让 engine 优雅停机（/internal/shutdown → drain → 关 DB），
                // 再放行应用退出
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<EngineState>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(mut handle) = guard.take() {
                                handle.stop();
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
