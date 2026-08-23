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

const TASK_IDS = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
} as const

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

    await page.evaluate(
      ({ ids }) =>
        Promise.all([
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id: ids.c,
            title: 'Third',
            createdAtMs: 50,
          }),
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id: ids.b,
            title: 'Second',
            createdAtMs: 20,
          }),
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id: ids.a,
            title: 'First',
            createdAtMs: 10,
          }),
        ]),
      { ids: TASK_IDS },
    )

    const duplicateError = await page.evaluate(
      async ({ id }) => {
        try {
          await (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id,
            title: 'Duplicate',
            createdAtMs: 60,
          })
          return null
        } catch (error: unknown) {
          const safe = error as { code?: unknown; message?: unknown }
          return { code: safe.code, message: safe.message }
        }
      },
      { id: TASK_IDS.a },
    )
    expect(duplicateError).toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(duplicateError?.message).not.toMatch(
      /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
    )

    await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.renameTask({
          id,
          title: 'Second renamed',
          updatedAtMs: 100,
        }),
      { id: TASK_IDS.b },
    )
    await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.changeTaskStatus({
          id,
          operation: 'start',
          updatedAtMs: 100,
        }),
      { id: TASK_IDS.a },
    )

    const expectedTasks: readonly BrowserTask[] = [
      {
        id: TASK_IDS.a,
        title: 'First',
        status: 'doing',
        createdAtMs: 10,
        updatedAtMs: 100,
      },
      {
        id: TASK_IDS.b,
        title: 'Second renamed',
        status: 'todo',
        createdAtMs: 20,
        updatedAtMs: 100,
      },
      {
        id: TASK_IDS.c,
        title: 'Third',
        status: 'todo',
        createdAtMs: 50,
        updatedAtMs: 50,
      },
    ]
    await expect(
      page.evaluate(() =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.listTasks(),
      ),
    ).resolves.toEqual(expectedTasks)

    await context.close()
    context = null

    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
    })
    page = await openHarnessPage(context, configuredBaseURL)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    await expect(page.locator('#capability')).toHaveText('AVAILABLE')

    const afterRestart = await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.listTasks(),
    )
    expect(afterRestart).toEqual(expectedTasks)

    await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown(),
    )
  } finally {
    await context?.close()
    await rm(resolvedProfile, { recursive: true, force: true })
  }
})
