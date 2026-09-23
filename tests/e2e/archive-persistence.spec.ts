import { chromium, expect, test } from '@playwright/test'

/**
 * P5C S3 — real Archive (归档) browser acceptance with genuine persistence.
 *
 * This spec proves the complete Task / Note archive lifecycle with NO mocks
 * and NO injected results:
 *
 *   source-domain UI create
 *   → real archive through the normal product UI (Task detail "归档" / Note editor "归档")
 *   → canonical TaskService.archiveTask / NoteService.archive
 *   → existing shared Web persistence Worker
 *   → real sqlite-wasm
 *   → isolated OPFS
 *   → Unified Archive read-only list (task / note rows, entity labels, timestamps)
 *   → canonical Task / Note unarchive (取消归档)
 *   → Archive → Trash → Restore → Archive round trip for the Note
 *     (by design, a Trash restore of an archived row returns it to ARCHIVED,
 *      preserving archivedAtMs — never to ACTIVE)
 *   → final Note unarchive that preserves the latest autosaved content
 *
 * Storage safety: the spec owns an isolated Playwright browser profile
 * (`testInfo.outputPath('browser-profile')`). The user's real AppData, Data
 * Root, zhixing.db, OPFS, attachments and backups are never touched.
 *
 * Frozen contract relied upon here:
 *   - the Archive list is read-only: it exposes 取消归档 (unarchive) and 移入回收站
 *     (move to Trash) only — no permanent delete / clear archive / bulk actions
 *   - unarchive / move-to-Trash dispatch back to the canonical Task / Note services
 *   - the Note editor flushes the latest draft (autosave) before archiving, so the
 *     archived snapshot always reflects the most recent content
 *   - a Trash restore of an archived entity keeps archivedAtMs, so the row returns
 *     to the Archive list rather than to the active source workspace
 */

const SHARED_TOKEN = '知行归档'

const TASK_TITLE = `E2E 归档任务 ${SHARED_TOKEN}`
const NOTE_TITLE = `E2E 归档笔记 ${SHARED_TOKEN}`
const NOTE_CONTENT = `归档笔记初始正文 ${SHARED_TOKEN}。`
const NOTE_CONTENT_2 = `归档笔记更新正文 ${SHARED_TOKEN}。最新内容已保留。`

const LOAD_TIMEOUT = 60_000

type AppPage = import('@playwright/test').Page

/** Opens the Unified Archive workspace and waits for its real list load. */
async function openArchive(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/archive`)
  await expect(
    page.getByRole('status', { name: '正在加载归档' }),
  ).not.toBeVisible({ timeout: LOAD_TIMEOUT })
}

/** One Unified Archive row, matched by its recognizable UI identity. */
function archiveRow(page: AppPage, title: string): import('@playwright/test').Locator {
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
function trashRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="回收站条目"] li').filter({ hasText: title })
}

function taskRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.getByRole('button', { name: `查看任务详情：${title}` })
}

function noteRow(page: AppPage, title: string): import('@playwright/test').Locator {
  return page.locator('ul[aria-label="笔记列表"] li').filter({ hasText: title })
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

/**
 * While the Note is still ACTIVE, edits it to the LATEST content and lets the
 * editor autosave flush the draft. The next archive therefore snapshots the
 * latest content (autosave-before-archive safety).
 */
async function editNoteLatestContent(page: AppPage, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/notes`)
  const row = noteRow(page, NOTE_TITLE)
  await expect(row).toBeVisible({ timeout: LOAD_TIMEOUT })
  await row.getByRole('button').click()
  await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
    timeout: LOAD_TIMEOUT,
  })
  await expect(page.getByLabel('笔记正文')).toHaveValue(NOTE_CONTENT, {
    timeout: LOAD_TIMEOUT,
  })
  await page.getByLabel('笔记正文').fill(NOTE_CONTENT_2)
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

test('proves Unified Archive V1 through real Web persistence: archive, persist, unarchive, Trash round-trip', async ({
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

    // ---- EDIT the Note to its LATEST content while still ACTIVE ----
    await editNoteLatestContent(page, baseURL)

    // ---- ACTIVE: each entity is visible in its canonical source workspace ----
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- ARCHIVE through the normal product UI (real archive) ----
    await archiveTask(page, baseURL)
    await archiveNote(page, baseURL)

    // ---- SOURCE DOMAIN: no longer active ----
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })

    // ---- ARCHIVE LIST: both rows, with their entity labels (read-only repo) ----
    await openArchive(page, baseURL)
    await expect(archiveRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(
      archiveRow(page, TASK_TITLE).getByText('任务', { exact: true }),
    ).toBeVisible()
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(
      archiveRow(page, NOTE_TITLE).getByText('笔记', { exact: true }),
    ).toBeVisible()

    // ---- RELOAD: the same isolated profile must keep the OPFS archive state ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openArchive(page, baseURL)
    await expect(archiveRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- TASK UNARCHIVE through the canonical Task service ----
    await archiveRow(page, TASK_TITLE)
      .getByRole('button', { name: '取消归档' })
      .click()
    await expect(archiveRow(page, TASK_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })
    await page.goto(`${baseURL}/tasks`)
    await expect(taskRow(page, TASK_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // ---- NOTE: Archive → Trash → Restore → Archive round trip (§14–§16) ----
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    // Move the archived note to Trash (real moveToTrash dispatch).
    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '移入回收站' })
      .click()
    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '确认移入回收站' })
      .click()
    await expect(archiveRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    // Trash now owns the note (entity label preserved).
    await openTrash(page, baseURL)
    await expect(trashRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(
      trashRow(page, NOTE_TITLE).getByText('笔记', { exact: true }),
    ).toBeVisible()

    // Restore the note through the canonical Note service. By design, restoring
    // an archived row preserves archivedAtMs, so it returns to the ARCHIVE list
    // (not to the active Notes workspace).
    await trashRow(page, NOTE_TITLE).getByRole('button', { name: '恢复' }).click()
    await expect(trashRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })
    await page.goto(`${baseURL}/notes`)
    await expect(noteRow(page, NOTE_TITLE)).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(
      archiveRow(page, NOTE_TITLE).getByText('笔记', { exact: true }),
    ).toBeVisible()

    // ---- FINAL NOTE UNARCHIVE preserves the latest content (§17) ----
    // Reload persistence: the restored-to-archive note is still held in OPFS.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openArchive(page, baseURL)
    await expect(archiveRow(page, NOTE_TITLE)).toBeVisible({ timeout: LOAD_TIMEOUT })

    await archiveRow(page, NOTE_TITLE)
      .getByRole('button', { name: '取消归档' })
      .click()
    await expect(archiveRow(page, NOTE_TITLE)).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    })

    // The unarchived note is active again AND keeps its latest (pre-archive) content.
    await page.goto(`${baseURL}/notes`)
    const finalNoteRow = noteRow(page, NOTE_TITLE)
    await expect(finalNoteRow).toBeVisible({ timeout: LOAD_TIMEOUT })
    await finalNoteRow.getByRole('button').click()
    await expect(page.getByLabel('笔记标题')).toHaveValue(NOTE_TITLE, {
      timeout: LOAD_TIMEOUT,
    })
    await expect(page.getByLabel('笔记正文')).toHaveValue(NOTE_CONTENT_2, {
      timeout: LOAD_TIMEOUT,
    })

    // ---- RELOAD: the final persisted truth — both active, Archive empty ----
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
  } finally {
    await context.close()
  }
})
