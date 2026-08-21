//! Native commands module.
//!
//! Step 7 scope: 仅提供最小 smoke 命令，不实现数据库/文件系统/日志桥接等业务。

/// 最小健康检查命令：前端 → Tauri invoke → Rust 返回 "pong"。
///
/// 用途仅用于验证 React↔Tauri↔Rust 链路，不作为正式业务 API。
#[tauri::command]
pub fn native_ping() -> &'static str {
    "pong"
}
