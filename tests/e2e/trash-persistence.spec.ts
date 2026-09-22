import { chromium, expect, test } from '@playwright/test'

/**
 * P5B S4 — real Unified Trash V1 browser acceptance.
 *
 * This spec proves the complete Unified Trash round trip with NO mocks and NO
 * injected results:
 *
 *   source-domain UI create
 *   → real soft delete through the normal product UI
 *   → existing shared Web persistence Worker
 *   → real sqlite-wasm
 *   → isolated OPFS
 *   → Unified Trash list (task / note / diary)
 *   → canonical Task / Note / Diary restore services
 *   → source domain active again
 *   → Global Search active again
 *
 * Storage safety: the case owns an isolated Playwright browser profile
 * (`testInfo.outputPath('browser-profile')`). The user's real AppData, Data
 * Root, zhixing.db, OPFS, attachments and backups are never touched.
 *
 * Frozen V1 contract relied upon here:
 *   - entity types are exactly task / note / diary
 *   - Canvas, canvas nodes and canvas edges are intentionally OUT
 *   - restore is single-item and goes through the canonical source services
 *   - no permanent delete / empty trash / bulk restore / filters / Trash search
 */

/** Shared >=3 char token present in all three domains (trigram FTS path). */
const SHARED_TOKEN = '知行回收站'

const TASK_TITLE = `E2E 回收站任务 ${SHARED_TOKEN}`
const NOTE_TITLE = `E2E 回收站笔记 ${SHARED_TOKEN}`
const DIARY_TITLE = `E2E 回收站日记 ${SHARED_TOKEN}`
const NOTE_CONTENT = `回收站笔记正文 ${SHARED_TOKEN}。`
const DIARY_CONTENT = `回收站日记正文 ${SHARED_TOKEN}。`

const LOAD_TIMEOUT = 60_000

type AppPage = import('@playwright/test').Page

/** Opens the Unified Trash workspace and waits for its real list load. */
async function openTrash(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/trash`)
  await expect(
    page.getByRole('heading', { name: '回收站', level: 2 }),
  ).toBeVisible({ timeout: LOAD_TIMEOUT })
  // Product-level readiness signal: the Trash runtime skeleton is gone, so the
  // TrashService is wired through the real shared Worker.
  await expect(
    page.getByRole('status', { name: '正在加载回收站' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
}

/** One Unified Trash row, matched by its recognizable UI identity. */
function trashRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="回收站条目"] li').filter({ hasText: title })
}

async function openSearch(
  page: AppPage,
  baseURL: string,
  query: string,
): Promise<void> {
  await page.goto(`${baseURL}/search`)
  const input = page.getByLabel('搜索关键词')
  await expect(input).toBeEnabled({ timeout: LOAD_TIMEOUT })
  await expect(
    page.getByRole('status', { name: '正在加载搜索' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
  await input.fill(query)
  await page.getByRole('button', { name: '搜索' }).click()
}

function searchResult(
  page: AppPage,
  label: '任务' | '笔记' | '日记',
  title: string,
): import('@playwright/test').Locator {
  return page.getByRole('link', { name: `打开${label}：${title}` })
}

function taskRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.getByRole('button', { name: `查看任务详情：${title}` })
}

function noteRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="笔记列表"] li').filter({ hasText: title })
}

function diaryRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="日记列表"] li').filter({ hasText: title })
}

async function createTask(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/tasks`)
  const createTaskButton = page.getByRole('button', { name: '新建任务' })
  await expect(createTaskButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
  await createTaskButton.click()
  const titleInput = page.locator('#create-title')
  await expect(titleInput).toBeVisible({ timeout: LOAD_TIMEOUT })
  await titleInput.fill(TASK_TITLE)
  await page.getByRole('button', { name: '创建任务' }).click()
  await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
}

async function createNote(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/notes`)
  const createNoteButton = page
    .locator('header')
    .getByRole('button', { name: '新建笔记' })
  await expect(createNoteButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
  await createNoteButton.click()
  await page.getByLabel('笔记标题').fill(NOTE_TITLE)
  await page.getByLabel('笔记正文').fill(NOTE_CONTENT)
  await page.getByText('已保存', { exact: false }).waitFor({ timeout: LOAD_TIMEOUT })
}

async function createDiary(page: AppPage, baseURL: string): Promise<void> {
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
}

/** Soft-deletes the Task through its normal detail dialog. */
async function deleteTask(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/tasks`)
  await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
  await taskRow(page, TASK_TITLE).click()
  const dialog = page.getByRole('dialog').filter({ hasText: TASK_TITLE })
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT })
  await dialog.getByRole('button', { name: '移入回收站' }).click()
  await page.getByRole('button', { name: '确认移入回收站' }).click()
  await expect(taskRow(page, TASK_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

/** Soft-deletes the Note through its normal editor delete dialog. */
async function deleteNote(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/notes`)
  const row = noteRow(page, NOTE_TITLE)
  await expect(row).toBeVisible({ timeout: LOAD_TIMEOUT })
  await row.getByRole('button').click()
  await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
    timeout: LOAD_TIMEOUT,
  })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

/** Soft-deletes the Diary entry through its normal editor delete dialog. */
async function deleteDiary(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/diary`)
  const row = diaryRow(page, DIARY_TITLE)
  await expect(row).toBeVisible({ timeout: LOAD_TIMEOUT })
  await row.getByRole('button').click()
  await expect(page.getByLabel('日记标题')).toHaveValue(DIARY_TITLE, {
    timeout: LOAD_TIMEOUT,
  })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(diaryRow(page, DIARY_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

test('proves Unified Trash V1 through real Web persistence: delete, persist, restore, Search', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }
  const baseURL = configuredBaseURL

  // Playwright-owned isolated persistent profile: the only OPFS this test
  // touches lives inside the test output directory.
  const profilePath = testInfo.outputPath('browser-profile')
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })

  try {
    const page = await context.newPage()

    // ---- CREATE the three real source entities through product UI ----
    await createTask(page, baseURL)
    await createNote(page, baseURL)
    await createDiary(page, baseURL)

    // ---- ACTIVE: each entity is visible in its canonical source workspace ----
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/diary`)
    const createdDiaryRow = diaryRow(page, DIARY_TITLE)
    await expect(createdDiaryRow).toBeVisible({ timeout: LOAD_TIMEOUT })
    // The diary date identity that restore must preserve.
    const diaryDateBefore = (
      (await createdDiaryRow.locator('span').first().textContent()) ?? ''
    ).trim()
    expect(diaryDateBefore).not.toBe('')

    // ---- BEFORE-STATE: all three are searchable while active ----
    await openSearch(page, baseURL, SHARED_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '日记', DIARY_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    // ---- DELETE through the normal product UI (real soft delete) ----
    await deleteTask(page, baseURL)
    await deleteNote(page, baseURL)
    await deleteDiary(page, baseURL)

    // ---- SOURCE DOMAIN: no longer active ----
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/diary`)
    await expect(diaryRow(page, DIARY_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })

    // ---- SEARCH: deleted entities are excluded ----
    await openSearch(page, baseURL, SHARED_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toHaveCount(0)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)
    await expect(searchResult(page, '日记', DIARY_TITLE)).toHaveCount(0)
    await expect(page.getByText('没有找到与')).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- UNIFIED TRASH: all three rows, with their entity labels ----
    await openTrash(page, baseURL)
    await expect(trashRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(trashRow(page, TASK_TITLE).getByText('任务', { exact: true })).toBeVisible()
    await expect(trashRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(trashRow(page, NOTE_TITLE).getByText('笔记', { exact: true })).toBeVisible()
    await expect(trashRow(page, DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(
      trashRow(page, DIARY_TITLE).getByText('日记', { exact: true }),
    ).toBeVisible()
    // Each row offers exactly the single-item restore action.
    await expect(
      trashRow(page, TASK_TITLE).getByRole('button', { name: '恢复' }),
    ).toBeVisible()

    // ---- RELOAD: the same isolated profile must keep the OPFS trash state ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openTrash(page, baseURL)
    await expect(trashRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(trashRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(trashRow(page, DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- RESTORE TASK through the canonical Task service ----
    await trashRow(page, TASK_TITLE).getByRole('button', { name: '恢复' }).click()
    await expect(trashRow(page, TASK_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- RESTORE NOTE through the canonical Note service ----
    await openTrash(page, baseURL)
    await trashRow(page, NOTE_TITLE).getByRole('button', { name: '恢复' }).click()
    await expect(trashRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/notes`)
    const restoredNoteRow = noteRow(page, NOTE_TITLE)
    await expect(restoredNoteRow).toBeVisible({ timeout: LOAD_TIMEOUT })
    await restoredNoteRow.getByRole('button').click()
    await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
      timeout: LOAD_TIMEOUT,
    })
    await expect(page.getByLabel('笔记正文')).toHaveValue(NOTE_CONTENT, {
      timeout: LOAD_TIMEOUT,
    })

    // ---- RESTORE DIARY through the canonical Diary service ----
    await openTrash(page, baseURL)
    await trashRow(page, DIARY_TITLE).getByRole('button', { name: '恢复' }).click()
    await expect(trashRow(page, DIARY_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/diary`)
    const restoredDiaryRow = diaryRow(page, DIARY_TITLE)
    await expect(restoredDiaryRow).toBeVisible({ timeout: LOAD_TIMEOUT })
    // The original diary date identity must survive restore unchanged.
    const diaryDateAfter = (
      (await restoredDiaryRow.locator('span').first().textContent()) ?? ''
    ).trim()
    expect(diaryDateAfter).toBe(diaryDateBefore)

    // ---- EMPTY TRASH STATE, with no destructive affordances ----
    await openTrash(page, baseURL)
    await expect(
      page.getByRole('heading', { name: '回收站是空的' }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(page.getByRole('button', { name: '永久删除' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '清空回收站' })).toHaveCount(0)

    // ---- SEARCH REINCLUSION: canonical restore re-activates Search ----
    await openSearch(page, baseURL, SHARED_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '日记', DIARY_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    // ---- RELOAD: the restored state is the persisted truth ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await openTrash(page, baseURL)
    await expect(
      page.getByRole('heading', { name: '回收站是空的' }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/diary`)
    await expect(diaryRow(page, DIARY_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await openSearch(page, baseURL, SHARED_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '日记', DIARY_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
  } finally {
    await context.close()
  }
})
