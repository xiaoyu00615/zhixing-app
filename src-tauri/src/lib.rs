//! Zhixing native library entry point.
//!
//! 模块边界：
//! - commands：Tauri invoke 命令集合（Step 7 仅 native_ping）。
//!
//! 本阶段不引入数据库、日志桥接、文件系统业务、数据根目录等后续 Step 内容。

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::native_ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
