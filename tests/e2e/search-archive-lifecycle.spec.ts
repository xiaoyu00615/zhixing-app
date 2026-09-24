import { chromium, expect, test } from '@playwright/test'

/**
 * P5C S4 — real Search × Archive lifecycle browser acceptance.
 *
 * This spec is the browser-level evidence that closes the S2.5 watch:
 * it proves the ordinary Global Search V1 projection tracks the FULL
 * Task / Note archive lifecycle across the real product stack, with NO mocks
 * and NO injected results:
 *
 *   domain UI create
 *   → real archive through the normal product UI (Task detail "归档" / Note editor "归档")
 *   → canonical TaskService.archiveTask / NoteService.archive
 *   → existing shared Web persistence Worker
 *   → real sqlite-wasm
 *   → isolated OPFS
 *   → migration 0013 (search_documents / search_fts) + migration 0015 triggers
 *   → SearchPage (ordinary Global Search)
 *   → ArchivePage / TrashPage (canonical unarchive / moveToTrash / restore)
 *
 * Frozen contract proven here:
 *   Active          → searchable
 *   Archived        → NOT searchable
 *   Trashed(from archive) → NOT searchable
 *   Trash restore of an archived row → returns to ARCHIVED → still NOT searchable
 *   Unarchive       → searchable again
 *
 * Storage safety: the spec owns an isolated Playwright browser profile
 * (`testInfo.outputPath('browser-profile')`). The user's real AppData, Data
 * Root, zhixing.db, OPFS, attachments and backups are never touched.
 *
 * No Search mock, no Archive mock, no direct DB seed, no manual index mutation.
 */

/** >=3 char token present only in the Task title (trigram FTS path). */
const TASK_SEARCH_TOKEN = '靛蓝归档'
/** >=3 char token present only in the Note title. */
const NOTE_TITLE_TOKEN = '绛紫检索'
/** >=3 char token present ONLY in the Note body (proves content indexing). */
const NOTE_BODY_TOKEN = '松绿笔记'

const TASK_TITLE = `E2E 归档检索任务 ${TASK_SEARCH_TOKEN}`
const NOTE_TITLE = `E2E 归档检索笔记 ${NOTE_TITLE_TOKEN}`
const NOTE_CONTENT = `归档检索笔记正文，含 ${NOTE_BODY_TOKEN}。`

const LOAD_TIMEOUT = 60_000

type AppPage = import('@playwright/test').Page

/** Opens the ordinary Global Search page, waits for readiness, runs a query. */
async function openSearchAndQuery(
  page: AppPage,
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

/** A single cross-domain Search result link. */
function searchResult(
  page: AppPage,
  label: '任务' | '笔记',
  title: string,
): import('@playwright/test').Locator {
  return page.getByRole('link', { name: `打开${label}：${title}` })
}

/** Opens the Unified Archive workspace and waits for its real list load. */
async function openArchive(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/archive`)
  await expect(
    page.getByRole('status', { name: '正在加载归档' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
}

/** One Unified Archive row, matched by its recognizable UI identity. */
function archiveRow(
  page: AppPage,
  title: string,
): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="归档条目"] li').filter({ hasText: title })
}

/** Opens the Unified Trash workspace and waits for its real list load. */
async function openTrash(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/trash`)
  await expect(
    page.getByRole('heading', { name: '回收站', level: 2 }),
  ).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect(
    page.getByRole('status', { name: '正在加载回收站' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
}

/** One Unified Trash row, matched by its recognizable UI identity. */
function trashRow(
  page: AppPage,
  title: string,
): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="回收站条目"] li').filter({ hasText: title })
}

function taskRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.getByRole('button', { name: `查看任务详情：${title}` })
}

function noteRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page
    .locator('ul[aria-label="笔记列表"] li')
    .filter({ hasText: title })
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

/** Archives a Task through its normal detail dialog (real archiveTask). */
async function archiveTask(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/tasks`)
  await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
  await taskRow(page, TASK_TITLE).click()
  const dialog = page.getByRole('dialog').filter({ hasText: TASK_TITLE })
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT })
  await dialog.getByRole('button', { name: '归档', exact: true }).click()
  await expect(taskRow(page, TASK_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

/** Archives a Note through its normal editor footer (real NoteService.archive). */
async function archiveNote(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/notes`)
  const row = noteRow(page, NOTE_TITLE)
  await expect(row).toBeVisible({ timeout: LOAD_TIMEOUT })
  await row.getByRole('button').click()
  await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
    timeout: LOAD_TIMEOUT,
  })
  const archiveButton = page.getByRole('button', { name: '归档', exact: true })
  await expect(archiveButton).toBeEnabled({ timeout: LOAD_TIMEOUT })
  await archiveButton.click()
  await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

test('proves ordinary Search tracks the full Task/Note archive lifecycle over real OPFS', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }
  const baseURL = configuredBaseURL

  // Playwright-owned isolated persistent profile: the only OPFS this spec
  // touches lives inside the test output directory.
  const profilePath = testInfo.outputPath('browser-profile')
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })

  try {
    const page = await context.newPage()

    // ---- CREATE the two real source entities through product UI ----
    await createTask(page, baseURL)
    await createNote(page, baseURL)

    // ---- §10 ACTIVE SEARCH BASELINE: all three tokens hit ----
    await openSearchAndQuery(page, baseURL, TASK_SEARCH_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    // Note BODY-only token: the projection indexes note content, not just title.
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await expect(searchResult(page, '任务', TASK_TITLE)).toHaveCount(0)

    // ---- §11 ARCHIVE both through the normal product UI (real archive) ----
    await archiveTask(page, baseURL)
    await archiveNote(page, baseURL)

    // ---- §12 ARCHIVE SEARCH EXCLUSION (the core S2.5 browser evidence) ----
    await openSearchAndQuery(page, baseURL, TASK_SEARCH_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toHaveCount(0)

    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    // ---- §13 ARCHIVE RELOAD: both rows survive the reload ----
    await openArchive(page, baseURL)
    await expect(archiveRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openArchive(page, baseURL)
    await expect(archiveRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- §14 TASK UNARCHIVE: Task re-enters Search, Note stays excluded ----
    await archiveRow(page, TASK_TITLE)
      .getByRole('button', { name: '取消归档' })
      .click()
    await expect(archiveRow(page, TASK_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    await openSearchAndQuery(page, baseURL, TASK_SEARCH_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    // ---- §15 NOTE ARCHIVE → TRASH ----
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '移入回收站' })
      .click()
    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '确认移入回收站' })
      .click()
    await expect(archiveRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    // Trash now owns the note; it stays excluded from Search.
    await openTrash(page, baseURL)
    await expect(trashRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    // ---- §16 TRASH RESTORE → ARCHIVE (not Active) ----
    await openTrash(page, baseURL)
    await trashRow(page, NOTE_TITLE).getByRole('button', { name: '恢复' }).click()
    await expect(trashRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    // The restored note is NOT active; it returns to the Archive list.
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // And it is still excluded from the ordinary Search projection.
    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toHaveCount(0)

    // ---- §17 FINAL NOTE UNARCHIVE: projection restored ----
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '取消归档' })
      .click()
    await expect(archiveRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    // Active again in Notes, with its content preserved.
    await page.goto(`${baseURL}/notes`)
    const finalNoteRow = noteRow(page, NOTE_TITLE)
    await expect(finalNoteRow).toBeVisible({ timeout: LOAD_TIMEOUT })
    await finalNoteRow.getByRole('button').click()
    await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
      timeout: LOAD_TIMEOUT,
    })
    await expect(page.getByLabel('笔记正文')).toHaveValue(NOTE_CONTENT, {
      timeout: LOAD_TIMEOUT,
    })

    // Title token AND body-only token are searchable again.
    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })

    // ---- §18 RELOAD FINAL STATE ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await openArchive(page, baseURL)
    await expect(
      page.getByRole('heading', { name: '归档是空的' }),
    ).toBeVisible({ timeout: LOAD_TIMEOUT })

    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await openSearchAndQuery(page, baseURL, TASK_SEARCH_TOKEN)
    await expect(searchResult(page, '任务', TASK_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await openSearchAndQuery(page, baseURL, NOTE_TITLE_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
    await openSearchAndQuery(page, baseURL, NOTE_BODY_TOKEN)
    await expect(searchResult(page, '笔记', NOTE_TITLE)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    })
  } finally {
    await context.close()
  }
})
