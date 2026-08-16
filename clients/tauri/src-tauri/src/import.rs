//! 打开即预览（Windows 文件关联）：双击 .md / 拖到 exe → 在 web 端只读展示，不入库。
//!
//! 事件来源（均由 lib.rs 接线）：
//! - 冷启动：Windows 以文件路径为 argv 拉起新实例
//! - 已运行：single_instance 插件回调带第二实例 argv
//!
//! 预览不走 engine REST（不再入库），改为壳层通过 `win.eval` 向 webview
//! 派发 `notefast:preview` CustomEvent，由 web 端 `useFileOpenEvents`
//! 累积队列展示在 /preview 页。
//!
//! 时序：web 端 useFileOpenEvents 模块加载后会调用 invoke('on_web_ready')，
//! 此时才允许派发事件——否则冷启动期 dispatch 的事件 web 收不到。
//! 中途新到的文件（已运行实例的导入）web 已 ready，立即派发。
//!
//! 启动页（splash）被本路径覆盖：原「splash 停留等导入」语义不存在了
//! （预览不依赖 engine REST），但 `PendingOpenFiles` 标志保留给前端决定
//! splash 最短停留时长（防淡出被 dispatch 抢占）。具体由前端 ui/app.js
//! 据 has_pending_open_files() 处理。

use crate::engine::EngineInfo;
use crate::{PendingPreviewFiles, PreviewReady};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 判断 Markdown 后缀（与 macOS 壳的集合一致）
pub fn is_markdown_path(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "mdown" | "mkd" | "txt")
    )
}

/// 入口：过滤出实际存在的 md 文件，加入预览队列。
/// 派发时机由 webReady 标志决定（见模块注释）。
pub fn handle_open_files(app: &AppHandle, paths: Vec<PathBuf>) {
    let files: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| is_markdown_path(p) && p.is_file())
        .collect();
    if files.is_empty() {
        return;
    }
    let state = match app.try_state::<PendingPreviewFiles>() {
        Some(s) => s,
        None => return,
    };
    let mut queue = state.0.lock().expect("PendingPreviewFiles 锁被污染");
    for f in files {
        queue.push(f);
    }
    drop(queue);
    try_drain(app);
}

/// webReady 已置位的前提下排空队列 + 派发事件 + 导航 /preview
pub fn try_drain(app: &AppHandle) {
    let ready = app
        .try_state::<PreviewReady>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(false);
    if !ready {
        return;
    }
    let files: Vec<PathBuf> = match app.try_state::<PendingPreviewFiles>() {
        Some(state) => {
            let mut guard = state.0.lock().expect("PendingPreviewFiles 锁被污染");
            std::mem::take(&mut *guard)
        }
        None => return,
    };
    if files.is_empty() {
        return;
    }
    // 派发每项文件的预览事件；失败/读不出 → eprintln，不打扰用户（应用已运行时）
    for f in &files {
        match dispatch_preview(app, f) {
            Ok(()) => {}
            Err(e) => eprintln!("[notefast] 预览失败 {}: {e}", f.display()),
        }
    }
    // 导航 /preview；web 监听器已就绪（try_drain 已校验），跳转不会被启动页 replace 抢占。
    // 已在 /preview（冷启动 splash 直跳）时跳过：整页加载会销毁 JS 上下文，
    // 虽可经 sessionStorage 恢复，但白屏刷新没有必要
    if let Some(win) = app.get_webview_window("main") {
        let already_on_preview = win.url().map(|u| u.path() == "/preview").unwrap_or(false);
        if !already_on_preview {
            if let Some(info) = current_engine_info(app) {
                let url = format!("http://127.0.0.1:{}/preview?native=tauri", info.port);
                if let Ok(js) = serde_json::to_string(&url) {
                    let _ = win.eval(&format!("location.href = {js}"));
                }
            } else {
                // engine 未就绪时只能跳相对路径（127.0.0.1:port 未知）
                let _ = win.eval("location.href = '/preview?native=tauri'");
            }
        }
    }
}

fn current_engine_info(app: &AppHandle) -> Option<EngineInfo> {
    use crate::EngineState;
    let state = app.try_state::<EngineState>()?;
    let guard = state.0.lock().ok()?;
    let handle = guard.as_ref()?;
    Some(handle.info.clone())
}

/// 读取文件内容并通过 `win.eval` 派发 `notefast:preview` CustomEvent。
/// content 经 JSON 序列化注入 JS 字符串字面量，避免手动转义陷阱。
fn dispatch_preview(app: &AppHandle, path: &Path) -> Result<(), String> {
    let markdown = std::fs::read_to_string(path).map_err(|e| format!("无法读取: {e}"))?;
    if markdown.trim().is_empty() {
        return Err("文件为空".to_string());
    }
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名文档")
        .to_string();
    let external_id = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    let detail = json!({
        "title": title,
        "content": markdown,
        "path": external_id,
        "contentHash": "",
    });
    let detail_json = serde_json::to_string(&detail).map_err(|e| format!("detail 序列化失败: {e}"))?;
    let script = format!(
        "window.dispatchEvent(new CustomEvent('notefast:preview',{{detail:{}}}))",
        detail_json
    );
    let win = app.get_webview_window("main").ok_or_else(|| "无 webview 窗口".to_string())?;
    win.eval(&script).map_err(|e| format!("eval 失败: {e}"))?;
    Ok(())
}