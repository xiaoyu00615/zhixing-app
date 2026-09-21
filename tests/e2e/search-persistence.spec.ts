import { chromium, expect, test } from '@playwright/test'

/**
 * P5 S5 — real Global Search V1 browser acceptance.
 *
 * This spec proves the complete path with NO Search mocks and NO injected
 * results:
 *
 *   domain UI create flow
 *   → Web shared persistence
 *   → sqlite-wasm
 *   → OPFS
 *   → migration 0013 (search_documents / search_fts)
 *   → SearchRepository / SearchService
 *   → SearchPage
 *   → result navigation (?id= deep link)
 *
 * Storage safety: every case owns an isolated Playwright browser profile
 * (`testInfo.outputPath('browser-profile')`). The user's real AppData, Data
 * Root, zhixing.db and OPFS are never touched.
 *
 * Frozen V1 contract relied upon here:
 *   - Task: title only
 *   - Note: title + content
 *   - Diary: title + content
 *   - Canvas: title only (node text is NOT searched)
 *   - <3 char term → escaped LIKE, >=3 char term → trigram FTS MATCH
 *   - only active entities are searchable
 */

/** Shared >=3 char token present in all four domains (trigram FTS path). */
const SHARED_TOKEN = '知行检索验证'
/** Note-content-only >=3 char token (proves body indexing). */
const NOTE_BODY_TOKEN = '墨痕检索'
/** Diary-content-only >=3 char token (proves body indexing). */
const DIARY_BODY_TOKEN = '灯下检索'
/** 2-char token, Task title only (proves the frozen <3 char LIKE fallback). */
const SHORT_TOKEN = 'qz'

const TASK_TITLE = `E2E 检索任务 ${SHARED_TOKEN} ${SHORT_TOKEN}`
const NOTE_TITLE = `E2E 检索笔记 ${SHARED_TOKEN}`
const DIARY_TITLE = `E2E 检索日记 ${SHARED_TOKEN}`
const CANVAS_TITLE = `E2E 检索画布 ${SHARED_TOKEN}`
const NOTE_CONTENT = `笔记正文行。${NOTE_BODY_TOKEN}。`
const DIARY_CONTENT = `日记正文行。${DIARY_BODY_TOKEN}。`

const LOAD_TIMEOUT = 60_000

interface SearchPageContext {
  readonly baseURL: string
}

async function openSearchAndQuery(
  page: import('@playwright/test').Page,
  baseURL: string,
  query: string,
): Promise<void> {
  await page.goto(`${baseURL}/search`)
  const input = page.getByLabel('搜索关键词')
  await expect(input).toBeEnabled({ timeout: LOAD_TIMEOUT })
  // Product-level readiness signal: the runtime loading status is gone, so the
  // SearchService is wired and a submission is actually served.
  await expect(
    page.getByRole('status', { name: '正在加载搜索' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
  await input.fill(query)
  await page.getByRole('button', { name: '搜索' }).click()
}

function resultLink(
  page: import('@playwright/test').Page,
  label: '任务' | '笔记' | '日记' | '画布',
  title: string,
): import('@playwright/test').Locator {
  return page.getByRole('link', { name: `打开${label}：${title}` })
}

/**
 * The Task detail dialog composes its accessible name from a sr-only prefix and
 * the title, so it is matched by content instead of an exact name string.
 */
function taskDetailDialog(
  page: import('@playwright/test').Page,
  title: string,
): import('@playwright/test').Locator {
  return page.getByRole('dialog').filter({ hasText: title })
}

test('proves cross-domain Global Search over real OPFS persistence', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(300_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }
  const baseURL: SearchPageContext['baseURL'] = configuredBaseURL

  const profilePath = testInfo.outputPath('browser-profile')
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })

  try {
    const page = await context.newPage()

    // ---- CREATE: TASK (real product flow, title only) ----
    await page.goto(`${baseURL}/tasks`)
    const createTaskButton = page.getByRole('button', { name: '新建任务' })
    await expect(createTaskButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await createTaskButton.click()
    const taskTitleInput = page.locator('#create-title')
    await expect(taskTitleInput).toBeVisible({ timeout: LOAD_TIMEOUT })
    await taskTitleInput.fill(TASK_TITLE)
    await page.getByRole('button', { name: '创建任务' }).click()
    await expect(
      page.getByRole('button', { name: `查看任务详情：${TASK_TITLE}` }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- CREATE: NOTE (title + content) ----
    await page.goto(`${baseURL}/notes`)
    const createNoteButton = page
      .locator('header')
      .getByRole('button', { name: '新建笔记' })
    await expect(createNoteButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await createNoteButton.click()
    await page.getByLabel('笔记标题').fill(NOTE_TITLE)
    await page.getByLabel('笔记正文').fill(NOTE_CONTENT)
    await page.getByText('已保存', { exact: false }).waitFor({ timeout: LOAD_TIMEOUT })

    // ---- CREATE: DIARY (title + content) ----
    await page.goto(`${baseURL}/diary`)
    const createDiaryButton = page
      .locator('header')
      .getByRole('button', { name: '新建日记' })
    await expect(createDiaryButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await createDiaryButton.click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.getByLabel('日记标题')).toBeVisible({ timeout: LOAD_TIMEOUT })
    await page.getByLabel('日记标题').fill(DIARY_TITLE)
    await page.getByLabel('日记正文').fill(DIARY_CONTENT)
    await page.getByText('已保存', { exact: false }).waitFor({ timeout: LOAD_TIMEOUT })

    // ---- CREATE: CANVAS (title only) ----
    await page.goto(`${baseURL}/canvas`)
    const createCanvasButton = page.getByRole('button', { name: '新建画布' })
    await expect(createCanvasButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await createCanvasButton.click()
    await page.getByLabel('画布名称').fill(CANVAS_TITLE)
    await page.getByRole('button', { name: '保存' }).click()
    // Creating a Canvas opens its editor immediately.
    await expect(
      page.getByRole('heading', { name: CANVAS_TITLE, level: 2 }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- CROSS-DOMAIN SEARCH (>=3 char shared token → trigram FTS) ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    const results = page.getByRole('list', { name: '搜索结果' })
    await results.waitFor({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '任务', TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '笔记', NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '日记', DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '画布', CANVAS_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- NOTE BODY SEARCH (token exists only in note content) ----
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(resultLink(page, '笔记', NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '任务', TASK_TITLE)).toHaveCount(0)

    // ---- DIARY BODY SEARCH (token exists only in diary content) ----
    await openSearchAndQuery(page, baseURL, DIARY_BODY_TOKEN)
    await expect(resultLink(page, '日记', DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    // ---- SHORT QUERY FALLBACK (<3 char → escaped LIKE) ----
    await openSearchAndQuery(page, baseURL, SHORT_TOKEN)
    await expect(resultLink(page, '任务', TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '笔记', NOTE_TITLE)).toHaveCount(0)
    await expect(resultLink(page, '日记', DIARY_TITLE)).toHaveCount(0)
    await expect(resultLink(page, '画布', CANVAS_TITLE)).toHaveCount(0)

    // ---- RELOAD: the same isolated profile must keep OPFS data ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    const reloadedResults = page.getByRole('list', { name: '搜索结果' })
    await reloadedResults.waitFor({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '任务', TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '笔记', NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '日记', DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(resultLink(page, '画布', CANVAS_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- OPEN TASK RESULT (?id= deep link) ----
    await resultLink(page, '任务', TASK_TITLE).click()
    await expect(page).toHaveURL(/\/tasks\?id=[0-9a-f-]+/)
    await expect(taskDetailDialog(page, TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    // ---- OPEN NOTE RESULT (?id= deep link) ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    await resultLink(page, '笔记', NOTE_TITLE).click()
    await expect(page).toHaveURL(/\/notes\?id=[0-9a-f-]+/)
    await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
      timeout: LOAD_TIMEOUT,
    })

    // ---- OPEN DIARY RESULT (?id= deep link) ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    await resultLink(page, '日记', DIARY_TITLE).click()
    await expect(page).toHaveURL(/\/diary\?id=[0-9a-f-]+/)
    await expect(page.getByLabel('日记标题')).toHaveValue(DIARY_TITLE, {
      timeout: LOAD_TIMEOUT,
    })

    // ---- OPEN CANVAS RESULT (/canvas/<canvasId>) ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    await resultLink(page, '画布', CANVAS_TITLE).click()
    await expect(page).toHaveURL(/\/canvas\/[0-9a-f-]+/)
    await expect(
      page.getByRole('heading', { name: CANVAS_TITLE, level: 2 }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })
  } finally {
    await context.close()
  }
})

test('proves Search covers only active entities after a normal soft delete', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(240_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }
  const baseURL = configuredBaseURL

  const profilePath = testInfo.outputPath('browser-profile')
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })

  try {
    const page = await context.newPage()
    const taskTitle = `E2E 检索删除 ${SHARED_TOKEN}`

    await page.goto(`${baseURL}/tasks`)
    const createTaskButton = page.getByRole('button', { name: '新建任务' })
    await expect(createTaskButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await createTaskButton.click()
    await page.locator('#create-title').fill(taskTitle)
    await page.getByRole('button', { name: '创建任务' }).click()
    await expect(
      page.getByRole('button', { name: `查看任务详情：${taskTitle}` }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- ACTIVE: searchable ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    await expect(resultLink(page, '任务', taskTitle)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- SOFT DELETE through the normal product flow ----
    await page.goto(`${baseURL}/tasks`)
    await expect(
      page.getByRole('button', { name: `查看任务详情：${taskTitle}` }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })
    await page.getByRole('button', { name: `查看任务详情：${taskTitle}` }).click()
    await expect(taskDetailDialog(page, taskTitle)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await page.getByRole('button', { name: '移入回收站' }).click()
    await page.getByRole('button', { name: '确认移入回收站' }).click()

    // ---- TRASHED: no longer searchable ----
    await openSearchAndQuery(page, baseURL, SHARED_TOKEN)
    await expect(resultLink(page, '任务', taskTitle)).toHaveCount(0)
    const noResults = page.getByText('没有找到与')
    await expect(noResults).toBeVisible({ timeout: LOAD_TIMEOUT })
  } finally {
    await context.close()
  }
})
