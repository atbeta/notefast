//! 打开即导入（Windows 文件关联）：双击 .md / 拖到 exe → 导入收集箱并打开。
//!
//! 事件来源（均由 lib.rs 接线）：
//! - 冷启动：Windows 以文件路径为 argv 拉起新实例
//! - 已运行：single_instance 插件回调带第二实例 argv
//!
//! 导入走 engine REST（POST /api/v1/import/markdown，回环 trustedLocal 免鉴权）；
//! HTTP 用裸 TcpStream（与 engine.rs 的 send_shutdown_request 同模式，不引 HTTP 依赖）。
//! 注意：导入完成后导航须延时——前端启动页（ui/app.js）拿到 engine 信息会整页
//! replace 到 engine origin，过早 eval 会被这次启动跳转覆盖。

use crate::engine::EngineInfo;
use crate::EngineState;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// 等 engine 就绪（engine 由前端启动页拉起，文件打开可能先于它完成）
const ENGINE_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// 导入完成到导航的固定延时：让 app.js 的启动跳转先落地（见模块注释）。
/// 须 ≥ 启动页最短停留 + 淡出（app.js MIN_SPLASH_MS + FADE_MS ≈ 1.7s）。
const NAV_DELAY: Duration = Duration::from_millis(1800);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

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

/// 入口：过滤出实际存在的 md 文件，后台任务执行导入（不阻塞 UI / 单实例回调线程）。
/// `is_initial`：冷启动（setup 里 argv 带入）为 true，用于区分「splash 停留等导入」
/// 与「应用已运行、导入后直接跳转」两种场景。
pub fn handle_open_files(app: &AppHandle, paths: Vec<PathBuf>, is_initial: bool) {
    let files: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| is_markdown_path(p) && p.is_file())
        .collect();
    if files.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let r = tauri::async_runtime::spawn_blocking(move || import_and_open(&app, files, is_initial)).await;
        if let Err(e) = r {
            eprintln!("[notefast] 导入任务失败: {e}");
        }
    });}

fn import_and_open(app: &AppHandle, files: Vec<PathBuf>, is_initial: bool) {
    let Some(info) = wait_engine(app) else {
        eprintln!("[notefast] 等 engine 就绪超时，放弃导入");
        if is_initial {
            bail_to_home(app, None);
        }
        return;
    };
    let Some(notebook_id) = info.notebook_id.clone() else {
        eprintln!("[notefast] engine 握手缺少 notebookId，放弃导入");
        if is_initial {
            bail_to_home(app, Some(&info.entry_url()));
        }
        return;
    };

    let mut first_doc: Option<String> = None;
    let mut imported = 0usize;
    for f in &files {
        let Ok(markdown) = std::fs::read_to_string(f) else {
            eprintln!("[notefast] 无法读取（非 UTF-8？）: {}", f.display());
            continue;
        };
        if markdown.trim().is_empty() {
            continue;
        }
        let title = f
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名文档")
            .to_string();
        match post_import(info.port, &notebook_id, &title, &markdown, f) {
            Ok(doc_id) => {
                if first_doc.is_none() {
                    first_doc = Some(doc_id);
                }
                imported += 1;
            }
            Err(e) => eprintln!("[notefast] 导入失败 {}: {e}", f.display()),
        }
    }
    if imported == 0 {
        // 冷启动打开失败：跳回首页兜底，否则 splash 会一直停在「正在打开文档…」；
        // 应用已运行时（is_initial=false）导入失败不打扰当前页面。
        if is_initial {
            bail_to_home(app, Some(&info.entry_url()));
        }
        return;
    }

    // 单篇直接打开文档页（双击就是为了看，页面自带升格/丢弃入口）；多篇跳收集箱整理
    let target = if imported == 1 {
        first_doc.map(|id| format!("http://127.0.0.1:{}/doc/{}?native=tauri", info.port, id))
    } else {
        Some(format!("http://127.0.0.1:{}/inbox?native=tauri", info.port))
    };
    if let (Some(win), Some(url)) = (app.get_webview_window("main"), target) {
        // 冷启动带文件时 splash 停留等这次跳转（无启动 replace 竞态），不必再等 NAV_DELAY；
        // 应用已运行（第二实例导入）才需要延时，让 app.js 的启动跳转先落地。
        if !is_initial {
            std::thread::sleep(NAV_DELAY);
        }
        if let Ok(js) = serde_json::to_string(&url) {
            let _ = win.eval(format!("location.href = {js}"));
        }
    }
}

/// 冷启动导入失败时把 splash 放行到首页（避免停在「正在打开文档…」）。
/// `url`：引擎入口地址（wait_engine 拿到 info 时用它）；引擎端口未知时传 None，
/// 用相对跳转落在当前 origin（splash 与引擎同 origin 或经启动页跳转后的同源）。
fn bail_to_home(app: &AppHandle, url: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        let target = url
            .map(|u| u.to_string())
            .unwrap_or_else(|| "/?native=tauri".to_string());
        if let Ok(js) = serde_json::to_string(&target) {
            let _ = win.eval(format!("location.href = {js}"));
        }
    }
}

/// 轮询等 engine 握手完成（EngineState 由 engine_start 命令填充）
fn wait_engine(app: &AppHandle) -> Option<EngineInfo> {
    let deadline = Instant::now() + ENGINE_WAIT_TIMEOUT;
    loop {
        if let Some(state) = app.try_state::<EngineState>() {
            if let Ok(guard) = state.0.lock() {
                if let Some(handle) = guard.as_ref() {
                    return Some(handle.info.clone());
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// POST /api/v1/import/markdown（status=inbox），返回 doc.id。
/// 裸 TcpStream：Connection: close 后读到 EOF；兼容 Content-Length 与 chunked 两种响应。
/// source 传文件绝对路径：服务端按「同路径+同内容 hash」去重——
/// 重复打开同一文件直接返回既有文档，不再重复进收集箱。
fn post_import(port: u16, notebook_id: &str, title: &str, markdown: &str, path: &Path) -> Result<String, String> {
    let external_id = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    let body = json!({
        "notebook_id": notebook_id,
        "title": title,
        "markdown": markdown,
        "status": "inbox",
        "source": { "provider": "file-open", "external_id": external_id },
    })
    .to_string();

    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("连接 engine 失败: {e}"))?;
    let _ = stream.set_read_timeout(Some(HTTP_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HTTP_TIMEOUT));
    let req = format!(
        "POST /api/v1/import/markdown HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(req.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .map_err(|e| format!("发送请求失败: {e}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "响应缺少 header/body 分界".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let status_line = head.lines().next().unwrap_or("").to_string();
    if !status_line.contains(" 200") && !status_line.contains(" 201") {
        return Err(format!("HTTP 状态异常: {status_line}"));
    }
    let body_bytes = &raw[split + 4..];
    let body_text = if head.contains("transfer-encoding: chunked") {
        String::from_utf8_lossy(&decode_chunked(body_bytes)).to_string()
    } else {
        String::from_utf8_lossy(body_bytes).to_string()
    };

    let v: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("响应解析失败: {e}"))?;
    v["doc"]["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应缺 doc.id".to_string())
}

/// 最小 chunked 解码（hex 长度行 + CRLF 帧）
fn decode_chunked(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(pos) = data.windows(2).position(|w| w == b"\r\n") {
        let Ok(size) = usize::from_str_radix(String::from_utf8_lossy(&data[..pos]).trim(), 16)
        else {
            break;
        };
        data = &data[pos + 2..];
        if size == 0 || data.len() < size + 2 {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    out
}
