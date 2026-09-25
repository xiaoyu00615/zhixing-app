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
    const expected =
      process.env.TAURI_ENV_PLATFORM === undefined
        ? webMod.platformMaintenancePort
        : nativeMod.platformMaintenancePort
    expect(platformMaintenancePort).toBe(expected)
  })
})
