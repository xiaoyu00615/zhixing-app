import { defineConfig } from '@playwright/test'

const port = 4174
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/tests/e2e/persistence.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
