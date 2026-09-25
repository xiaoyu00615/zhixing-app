/**
 * P6-S4C · Native alias gate (spec §43)
 *
 * Proves the `@/maintenance/platform` alias resolves to the correct adapter:
 *   - default (web) build  -> Web adapter
 *   - TAURI_ENV_PLATFORM set -> Native adapter
 *
 * Run normally for the Web assertion; run again with TAURI_ENV_PLATFORM=1 for the
 * Native assertion. No installer is produced.
 */

import { describe, expect, test } from 'vitest'

import { platformMaintenancePort } from '@/maintenance/platform'
import * as webMod from '@/adapters/web/maintenance'
import * as nativeMod from '@/adapters/native/maintenance'

describe('maintenance platform alias resolution', () => {
  test('resolves to the build-selected adapter', () => {
    // `process` is intentionally read through a local structural type: the app
    // TS project does not include `@types/node` (this is the only `src/` file
    // that needs the ambient build-time env), so referencing it directly would
    // be an unresolved global.
    const env = (
      globalThis as { process?: { env?: Record<string, string | undefined> } }
    ).process?.env
    const expected =
      env?.TAURI_ENV_PLATFORM === undefined
        ? webMod.platformMaintenancePort
        : nativeMod.platformMaintenancePort
    expect(platformMaintenancePort).toBe(expected)
  })
})
