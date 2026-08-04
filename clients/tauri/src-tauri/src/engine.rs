//! 内嵌 NoteFast engine 进程管理（对应 server `src/native/bootstrap.ts` 契约）。
//!
//! 契约：
//! - spawn：`notefast-server --data-dir <dir> --port 0 --assets-dir <engineDir>`
//! - **stdout 是机器握手通道**：常规日志全部在 stderr，启动成功后写一行 `NF_READY <json>`；
//!   客户端按 `NF_READY ` 前缀扫描即可容错（与 macOS 壳 `EngineProcess.swift` 同模式）
//! - 优雅停机：Windows 无 SIGTERM 语义，经 `POST /internal/shutdown`（bootstrap 内部路由，
//!   仅回环 + trustedLocal 可及）触发 engine drain，超时未退再 TerminateProcess 兜底

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);

/// CREATE_NO_WINDOW：engine 是控制台子系统 exe，不带此标志会在每次启动时闪一个控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 握手行 JSON（字段对齐 bootstrap 的 NF_READY 输出；缺省字段宽容处理）。
/// `url` 是壳层入口地址（由 port 计算，非握手 JSON 自带），序列化时一并下发前端
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub port: u16,
    pub version: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notebook_id: Option<String>,
    #[serde(default)]
    pub api_path: Option<String>,
    #[serde(default)]
    pub mcp_path: Option<String>,
}

impl EngineInfo {
    /// 壳层加载入口：engine 自带的 web-dist 全站 UI
    pub fn entry_url(&self) -> String {
        format!("http://127.0.0.1:{}/?native=tauri", self.port)
    }
}

pub struct EngineHandle {
    child: Child,
    pub info: EngineInfo,
}

impl EngineHandle {
    fn new(child: Child, info: EngineInfo) -> Self {
        Self { child, info }
    }

    pub fn is_alive(&mut self) -> bool {
        self.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
    }

    /// 优雅停机：先 POST /internal/shutdown（engine drain 在飞请求 + 关 DB），
    /// 超时未退则强杀兜底
    pub fn stop(&mut self) {
        send_shutdown_request(self.info.port);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(_) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        // 进程仍活着才尝试停机（start 失败路径已自行清理，防止二次等待）
        if self.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            self.stop();
        }
    }
}

pub fn engine_binary_name() -> &'static str {
    if cfg!(windows) { "notefast-server.exe" } else { "notefast-server" }
}

/// 启动 engine 并阻塞等待 NF_READY 握手；超时或进程提前退出则报错（并清理进程）。
/// 注意：握手阻塞期间调用线程被占用，壳层应放线程池/异步执行。
pub fn start(engine_dir: &Path, data_dir: &Path) -> Result<EngineHandle, String> {
    let binary = engine_dir.join(engine_binary_name());
    if !binary.exists() {
        return Err(format!("engine 可执行文件不存在: {}", binary.display()));
    }
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("无法创建数据目录 {}: {e}", data_dir.display()))?;

    let mut cmd = new_engine_command(&binary);
    cmd.arg("--data-dir")
        .arg(data_dir)
        // 不传 --port：用 bootstrap 默认固定端口（3876，被占用自动回退随机）——
        // 固定端口让页面 origin 稳定，localStorage（主题/语言缓存）跨启动持久
        .arg("--assets-dir")
        .arg(engine_dir)
        .stdout(Stdio::piped())
        // stderr 不接管：engine 日志（含启动告警）不进握手通道
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("启动 engine 失败: {e}"))?;
    let stdout = child.stdout.take().expect("stdout 已 piped");

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(info) = parse_handshake(&line) {
                    return Ok(EngineHandle::new(child, info));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("engine 握手超时（未收到 NF_READY）".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.wait();
                return Err("engine 进程提前退出（握手未完成）".to_string());
            }
        }
    }
}

/// 从一行 stdout 解析握手；容忍前缀噪声（客户端按 `NF_READY ` 前缀扫描）
pub fn parse_handshake(line: &str) -> Option<EngineInfo> {
    let trimmed = line.trim();
    let json = trimmed.strip_prefix("NF_READY ")?;
    let mut info: EngineInfo = serde_json::from_str(json).ok()?;
    info.url = info.entry_url();
    Some(info)
}

fn new_engine_command(binary: &Path) -> Command {
    let mut cmd = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// POST /internal/shutdown（bootstrap 内部路由）：触发 engine 优雅停机。
/// 响应仅在 flush 完成后才触发停机，这里读到响应或读不到都无所谓——引擎会自行退出。
fn send_shutdown_request(port: u16) {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return;
    };
    let req = format!(
        "POST /internal/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(req.as_bytes());
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut buf = [0u8; 64];
    let _ = stream.read(&mut buf);
}
