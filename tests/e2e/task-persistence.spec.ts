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
  readonly isImportant: boolean
  readonly isUrgent: boolean
  readonly dueDate: string | null
  readonly projectId: string | null
  readonly tagIds: readonly string[]
}

interface BrowserProject {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

interface BrowserTag {
  readonly id: string
  readonly name: string
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
    isImportant?: boolean
    isUrgent?: boolean
    dueDate?: string | null
    projectId?: string | null
    tagIds?: readonly string[]
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
  createProject(input: {
    id: string
    name: string
    createdAtMs: number
  }): Promise<BrowserProject>
  listProjects(): Promise<readonly BrowserProject[]>
  renameProject(input: {
    id: string
    name: string
    updatedAtMs: number
  }): Promise<BrowserProject>
  createTag(input: {
    id: string
    name: string
    createdAtMs: number
  }): Promise<BrowserTag>
  listTags(): Promise<readonly BrowserTag[]>
  renameTag(input: {
    id: string
    name: string
    updatedAtMs: number
  }): Promise<BrowserTag>
  addTaskTag(input: {
    id: string
    tagId: string
    updatedAtMs: number
  }): Promise<BrowserTask>
  removeTaskTag(input: {
    id: string
    tagId: string
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
const PROJECT_ID = '00000000-0000-4000-8000-000000000101'
const TAG_IDS = {
  focus: '00000000-0000-4000-8000-000000000201',
  deep: '00000000-0000-4000-8000-000000000202',
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
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.createProject({
          id,
          name: 'Work',
          createdAtMs: 5,
        }),
      { id: PROJECT_ID },
    )

    await page.evaluate(
      ({ ids }) =>
        Promise.all([
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTag({
            id: ids.focus,
            name: '专注',
            createdAtMs: 7,
          }),
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTag({
            id: ids.deep,
            name: '深度工作',
            createdAtMs: 8,
          }),
        ]),
      { ids: TAG_IDS },
    )

    const missingProjectError = await page.evaluate(
      async ({ id }) => {
        try {
          await (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id,
            title: 'Missing project',
            createdAtMs: 6,
            projectId: '00000000-0000-4000-8000-000000000199',
          })
          return null
        } catch (error: unknown) {
          const safe = error as { code?: unknown; message?: unknown }
          return { code: safe.code, message: safe.message }
        }
      },
      { id: '00000000-0000-4000-8000-000000000004' },
    )
    expect(missingProjectError).toMatchObject({ code: 'NOT_FOUND' })
    expect(missingProjectError?.message).not.toMatch(
      /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
    )
    await expect(
      page.evaluate(() =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.listTasks(),
      ),
    ).resolves.toEqual([])

    const missingTagError = await page.evaluate(
      async ({ id }) => {
        try {
          await (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id,
            title: 'Missing tag',
            createdAtMs: 7,
            tagIds: ['00000000-0000-4000-8000-000000000299'],
          })
          return null
        } catch (error: unknown) {
          const safe = error as { code?: unknown; message?: unknown }
          return { code: safe.code, message: safe.message }
        }
      },
      { id: '00000000-0000-4000-8000-000000000005' },
    )
    expect(missingTagError).toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      page.evaluate(() =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.listTasks(),
      ),
    ).resolves.toEqual([])

    await page.evaluate(
      ({ ids, projectId, tagIds }) =>
        Promise.all([
          (
            window as unknown as HarnessWindow
          ).__taskPersistenceHarness.createTask({
            id: ids.c,
            title: 'Third',
            createdAtMs: 50,
            isImportant: true,
            isUrgent: true,
            dueDate: '2026-08-23',
            projectId,
            tagIds: [tagIds.focus],
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
      { ids: TASK_IDS, projectId: PROJECT_ID, tagIds: TAG_IDS },
    )

    await page.evaluate(
      ({ id, tagId }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.addTaskTag({
          id,
          tagId,
          updatedAtMs: 102,
        }),
      { id: TASK_IDS.a, tagId: TAG_IDS.deep },
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
    await page.evaluate(
      ({ id }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.renameProject({
          id,
          name: 'Work renamed',
          updatedAtMs: 101,
        }),
      { id: PROJECT_ID },
    )
    await page.evaluate(
      ({ id }) =>
        (window as unknown as HarnessWindow).__taskPersistenceHarness.renameTag(
          {
            id,
            name: '专注力',
            updatedAtMs: 103,
          },
        ),
      { id: TAG_IDS.focus },
    )

    const expectedTasks: readonly BrowserTask[] = [
      {
        id: TASK_IDS.a,
        title: 'First',
        status: 'doing',
        createdAtMs: 10,
        updatedAtMs: 100,
        isImportant: false,
        isUrgent: false,
        dueDate: null,
        projectId: null,
        tagIds: [TAG_IDS.deep],
      },
      {
        id: TASK_IDS.b,
        title: 'Second renamed',
        status: 'todo',
        createdAtMs: 20,
        updatedAtMs: 100,
        isImportant: false,
        isUrgent: false,
        dueDate: null,
        projectId: null,
        tagIds: [],
      },
      {
        id: TASK_IDS.c,
        title: 'Third',
        status: 'todo',
        createdAtMs: 50,
        updatedAtMs: 50,
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
        projectId: PROJECT_ID,
        tagIds: [TAG_IDS.focus],
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
    await expect(
      page.evaluate(() =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.listProjects(),
      ),
    ).resolves.toEqual([
      {
        id: PROJECT_ID,
        name: 'Work renamed',
        createdAtMs: 5,
        updatedAtMs: 101,
      },
    ])
    await expect(
      page.evaluate(() =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.listTags(),
      ),
    ).resolves.toEqual([
      {
        id: TAG_IDS.focus,
        name: '专注力',
        createdAtMs: 7,
        updatedAtMs: 103,
      },
      {
        id: TAG_IDS.deep,
        name: '深度工作',
        createdAtMs: 8,
        updatedAtMs: 8,
      },
    ])

    await page.evaluate(
      ({ id, tagId }) =>
        (
          window as unknown as HarnessWindow
        ).__taskPersistenceHarness.removeTaskTag({
          id,
          tagId,
          updatedAtMs: 110,
        }),
      { id: TASK_IDS.a, tagId: TAG_IDS.deep },
    )

    await page.goto(`${configuredBaseURL}/tasks`)
    await expect(page.getByText('Third', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await page
      .getByRole('combobox', { name: '筛选标签' })
      .selectOption(TAG_IDS.focus)
    await page.getByRole('button', { name: /^筛选\s*1$/ }).click()
    await expect(page.getByText('Third', { exact: true })).toBeVisible()
    await expect(page.getByText('First', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '取消重要：Third' }).click()
    await expect(
      page.getByRole('button', { name: '设为重要：Third' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '取消基础紧急：Third' }).click()
    await expect(
      page.getByRole('button', { name: '设为基础紧急：Third' }),
    ).toBeVisible()
    await page.getByLabel('任务截止日期：Third').fill('2026-09-30')
    await expect(page.getByLabel('任务截止日期：Third')).toHaveValue(
      '2026-09-30',
    )

    page = await openHarnessPage(context, configuredBaseURL)
    const afterPlanningChanges = await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.listTasks(),
    )
    expect(
      afterPlanningChanges.find((task) => task.id === TASK_IDS.c),
    ).toMatchObject({
      isImportant: false,
      isUrgent: false,
      dueDate: '2026-09-30',
    })

    await context.close()
    context = null
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
    })
    page = await openHarnessPage(context, configuredBaseURL)
    const afterPlanningRestart = await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.listTasks(),
    )
    expect(
      afterPlanningRestart.find((task) => task.id === TASK_IDS.c),
    ).toMatchObject({
      isImportant: false,
      isUrgent: false,
      dueDate: '2026-09-30',
    })

    await page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown(),
    )
  } finally {
    await context?.close()
    await rm(resolvedProfile, { recursive: true, force: true })
  }
})
