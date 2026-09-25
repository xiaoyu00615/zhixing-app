/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const taskRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/task/runtime.ts'
        : './src/task/runtime.native.ts',
      import.meta.url,
    ),
  )
  const canvasRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/canvas/runtime.ts'
        : './src/canvas/runtime.native.ts',
      import.meta.url,
    ),
  )
  const noteRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/note/runtime.ts'
        : './src/note/runtime.native.ts',
      import.meta.url,
    ),
  )
  const diaryRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/diary/runtime.ts'
        : './src/diary/runtime.native.ts',
      import.meta.url,
    ),
  )
  const searchRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/search/runtime.ts'
        : './src/search/runtime.native.ts',
      import.meta.url,
    ),
  )
  const trashRuntimeEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/trash/runtime.ts'
        : './src/trash/runtime.native.ts',
      import.meta.url,
    ),
  )

  // P6-S4C: platform maintenance adapter. Web build uses the Web adapter; the
  // Tauri/Native build uses the Native adapter. Selected purely by build-time
  // alias (never runtime sniffing), mirroring the existing runtime alias pattern.
  const maintenancePlatformEntry = fileURLToPath(
    new URL(
      process.env.TAURI_ENV_PLATFORM === undefined
        ? './src/adapters/web/maintenance.ts'
        : './src/adapters/native/maintenance.ts',
      import.meta.url,
    ),
  )

  return {
    plugins: [react(), tailwindcss()],
    server: {
      headers: crossOriginIsolationHeaders,
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
    optimizeDeps: {
      exclude: ['@sqlite.org/sqlite-wasm'],
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      exclude: [
        'tests/e2e/**',
        '**/node_modules/**',
        '.pnpm-cache/**',
        'dist/**',
        'test-results/**',
      ],
    },
    resolve: {
      alias: [
        { find: /^@\/task\/runtime$/, replacement: taskRuntimeEntry },
        { find: /^@\/canvas\/runtime$/, replacement: canvasRuntimeEntry },
        { find: /^@\/note\/runtime$/, replacement: noteRuntimeEntry },
        { find: /^@\/diary\/runtime$/, replacement: diaryRuntimeEntry },
        { find: /^@\/search\/runtime$/, replacement: searchRuntimeEntry },
        { find: /^@\/trash\/runtime$/, replacement: trashRuntimeEntry },
        {
          find: /^@\/maintenance\/platform$/,
          replacement: maintenancePlatformEntry,
        },
        {
          find: '@',
          replacement: fileURLToPath(new URL('./src', import.meta.url)),
        },
      ],
    },
    build:
      mode === 'e2e'
        ? {
            outDir: 'test-results/e2e-build',
            rollupOptions: {
              input: fileURLToPath(
                new URL('./tests/e2e/persistence.html', import.meta.url),
              ),
            },
          }
        : undefined,
  }
})
