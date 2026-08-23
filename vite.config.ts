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
