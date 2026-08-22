import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test'

interface BrowserTask {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

interface BrowserHarness {
  capability(): Promise<
    | { status: 'AVAILABLE' }
    | {
        status: 'UNAVAILABLE' | 'RESTRICTED'
        reason: string
      }
  >
  createTask(input: {
    id: string
    title: string
    createdAtMs: number
  }): Promise<BrowserTask>
  listTasks(): Promise<readonly BrowserTask[]>
  renameTask(input: {
    id: string
    title: string
    updatedAtMs: number
  }): Promise<BrowserTask>
  changeTaskStatus(input: {
    id: string
    operation: 'start'
    updatedAtMs: number
  }): Promise<BrowserTask>
  shutdown(): Promise<void>
}

type HarnessWindow = Window & { __taskPersistenceHarness: BrowserHarness }

const taskId = '12345678-1234-4321-8000-0123456789ab'

async function openHarnessPage(
  context: BrowserContext,
  baseURL: string,
): Promise<Page> {
  const pages = context.pages()
  const page = pages[0] ?? (await context.newPage())
  await page.goto(`${baseURL}/tests/e2e/persistence.html`)
  await page.waitForFunction(
    () =>
      '__taskPersistenceHarness' in window &&
      typeof (window as unknown as HarnessWindow).__taskPersistenceHarness
        .capability === 'function',
  )
  return page
}

test('persists Task operations in OPFS across a browser restart', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }

  const profilePath = testInfo.outputPath('browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) {
    throw new Error('Refusing to use an unowned browser profile path.')
  }

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
    })
    let page = await openHarnessPage(context, configuredBaseURL)

    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    const initialCapability = await page.evaluate(() =>
      (
        window as unknown as HarnessWindow
      ).__taskPersistenceHarness.capability(),
    )
    expect(initialCapability).toEqual({ status: 'AVAILABLE' })
    await expect(page.locator('#capability')).toHaveText('AVAILABLE')

    const created = await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.createTask({
          id,
          title: 'Persist across restart',
          createdAtMs: 100,
        }),
      { id: taskId },
    )
    expect(created).toMatchObject({
      id: taskId,
      status: 'todo',
      createdAtMs: 100,
      updatedAtMs: 100,
    })

    await context.close()
    context = null

    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
    })
    page = await openHarnessPage(context, configuredBaseURL)
    await expect(page.locator('#capability')).toHaveText('AVAILABLE')

    const afterRestart = await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.listTasks(),
    )
    expect(afterRestart).toEqual([created])

    const renamed = await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.renameTask({
          id,
          title: 'Renamed after restart',
          updatedAtMs: 200,
        }),
      { id: taskId },
    )
    expect(renamed).toMatchObject({
      title: 'Renamed after restart',
      updatedAtMs: 200,
    })

    const changed = await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.changeTaskStatus({
          id,
          operation: 'start',
          updatedAtMs: 300,
        }),
      { id: taskId },
    )
    expect(changed).toMatchObject({ status: 'doing', updatedAtMs: 300 })

    await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown(),
    )
  } finally {
    await context?.close()
    await rm(resolvedProfile, { recursive: true, force: true })
  }
})
