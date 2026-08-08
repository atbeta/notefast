//! NoteFast Windows 桌面客户端（Tauri 壳）
//!
//! 壳层职责：内嵌 engine 进程生命周期管理 + 最小启动页跳转。
//! 业务（block 模型/检索/AI/MCP/同步）全部复用 server engine，壳层不重写。

mod engine;
mod import;

use engine::{EngineHandle, EngineInfo};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 全局 engine 句柄（同一时刻只有一个内嵌实例）
struct EngineState(Mutex<Option<EngineHandle>>);

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
    let engine_dir = resolve_engine_dir(&app)?;
    let data_dir = default_data_dir(&app)?;

    let started = tauri::async_runtime::spawn_blocking(move || {
        engine::start(&engine_dir, &data_dir)
    })
    .await
    .map_err(|e| format!("engine 启动任务失败: {e}"))??;

    let info = started.info.clone();
    *state
        .0
        .lock()
        .map_err(|_| "engine state 锁被污染".to_string())? = Some(started);
    Ok(info)
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

/// 数据目录：%APPDATA%/NoteFast/data（macOS 壳为 ~/Library/Application Support/NoteFast/ 的对应物）
fn default_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(base.join("data"))
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
            let files: Vec<PathBuf> = args
                .into_iter()
                .map(PathBuf::from)
                .filter(|p| import::is_markdown_path(p) && p.is_file())
                .collect();
            import::handle_open_files(app, files);
        }))
        // 保存对话框 + 文件写入：前端导出 markdown/zip 时让用户选位置（而非静默下载到 Downloads）
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(EngineState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![engine_start])
        .setup(move |app| {
            // 启动闪屏：conf 里 visible=false，先按系统主题设 webview 底色再 show。
            // 否则静态 backgroundColor=#18181b 会在亮色 Windows 上先闪一块黑再变白启动页。
            if let Some(win) = app.get_webview_window("main") {
                let (r, g, b) = match win.theme() {
                    Ok(tauri::Theme::Light) => (0xfa, 0xfa, 0xfa),
                    _ => (0x18, 0x18, 0x1b),
                };
                let _ = win.set_background_color(Some(tauri::webview::Color::from((r, g, b, 255))));
                let _ = win.show();
            }
            // 冷启动带入的 .md：engine 由前端启动页拉起，import 内部会等它就绪
            if !initial_files.is_empty() {
                import::handle_open_files(&app.handle(), initial_files.clone());
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
