/**
 * Native Adapter - Infrastructure / Platform boundary.
 *
 * 唯一允许直接调用 @tauri-apps/api 的层级。
 * 业务层（Application Service / UI）不得直接使用 invoke。
 *
 * 正式架构：
 *   React UI → TypeScript Application Service → Repository / Platform Adapter
 *   → Native Adapter（本文件） → Tauri invoke → Rust Command → Rust Service
 *
 * Step 7 scope：仅最小 smoke 验证（native_ping）。
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * 最小 smoke 命令。仅验证通道可用性，不做业务语义。
 * 返回 "pong" 表示 React ↔ Tauri ↔ Rust 链路可用。
 */
export async function ping(): Promise<string> {
  return invoke<string>('native_ping');
}

export const nativeAdapter = {
  ping,
} as const;
