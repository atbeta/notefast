// Windows 桌面客户端入口（release 下不弹控制台窗口）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notefast_tauri_lib::run()
}
