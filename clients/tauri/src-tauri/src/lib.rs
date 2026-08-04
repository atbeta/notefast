//! NoteFast Windows 桌面客户端（Tauri 壳）
//!
//! 壳层职责：内嵌 engine 进程生命周期管理 + 最小启动页跳转。
//! 业务（block 模型/检索/AI/MCP/同步）全部复用 server engine，壳层不重写。

mod engine;

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

/// 定位 engine 产物目录：dev 模式读 NOTEFAST_ENGINE_DIR（指向 packages/server/dist-engine，
/// 与 macOS 壳同约定）；打包模式取资源目录 resources/engine/
fn resolve_engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("NOTEFAST_ENGINE_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
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
        "找不到 engine 产物。dev 模式请设置 NOTEFAST_ENGINE_DIR 指向 packages/server/dist-engine；\
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
    tauri::Builder::default()
        .manage(EngineState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![engine_start])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出链路：先让 engine 优雅停机（/internal/shutdown → drain → 关 DB），
            // 再放行应用退出
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<EngineState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut handle) = guard.take() {
                            handle.stop();
                        }
                    }
                }
            }
        });
}
