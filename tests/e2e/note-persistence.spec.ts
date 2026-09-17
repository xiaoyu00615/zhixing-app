import { chromium, expect, test } from '@playwright/test'

const NOTE_TITLE = 'E2E Note Persistence · Title'
const NOTE_CONTENT = '# E2E Note\n\n第一行\n  leading spaces\n最后一行 ✓\n\n日本語テスト'

test('persists Note create / edit / reload / delete in real OPFS', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(90_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }

  const profilePath = testInfo.outputPath('browser-profile')

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })
  try {
    const page = await context.newPage()

    // ---- OPEN /notes DIRECTLY (no harness navigation) ----
    await page.goto(`${configuredBaseURL}/notes`)
    // Wait for the page to be ready (phase === 'ready')
    await page.getByRole('heading', { name: '笔记', level: 2 }).waitFor({ timeout: 30_000 })
    await expect(page.getByRole('status', { name: '正在加载笔记' })).not.toBeVisible()

    // Wait for the create button to be enabled (service ready)
    await page.waitForSelector('button:has-text("新建笔记"):not([disabled])', { timeout: 30_000 })

    // ---- CREATE EMPTY NOTE ----
    const headerCreateBtn = page.locator('header').getByRole('button', { name: '新建笔记' })
    await expect(headerCreateBtn).toBeEnabled()
    await headerCreateBtn.click()

    // Wait for creation to complete
    const titleInput = page.getByLabel('笔记标题')
    await expect(titleInput).toBeVisible({ timeout: 30_000 })

    // ---- EDIT TITLE ----
    await titleInput.fill(NOTE_TITLE)

    // ---- EDIT CONTENT ----
    const contentTextarea = page.getByLabel('笔记正文')
    await contentTextarea.fill(NOTE_CONTENT)

    // ---- WAIT FOR AUTOSAVE ----
    await page.getByText('已保存', { exact: false }).waitFor({ timeout: 30_000 })

    // ---- FIRST RELOAD ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: '笔记', level: 2 }).waitFor({ timeout: 15_000 })

    // Find and select the note
    const noteList = page.getByRole('list', { name: '笔记列表' })
    await noteList.waitFor({ timeout: 10_000 })
    const noteItem = noteList.getByText(NOTE_TITLE, { exact: true })
    await expect(noteItem).toBeVisible({ timeout: 10_000 })
    await noteItem.click()

    // Verify editor fields
    await expect(titleInput).toHaveValue(NOTE_TITLE)
    await expect(contentTextarea).toHaveValue(NOTE_CONTENT)

    // ---- DELETE NOTE ----
    await page.getByRole('button', { name: '删除' }).click()
    await page.getByRole('button', { name: '确认删除' }).click()

    // Wait for the note to disappear
    await expect(noteItem).not.toBeVisible({ timeout: 10_000 })

    // ---- SECOND RELOAD ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: '笔记', level: 2 }).waitFor({ timeout: 15_000 })

    // Verify the deleted note is gone
    const noteListAfter = page.getByRole('list', { name: '笔记列表' })
    await expect(
      noteListAfter.getByText(NOTE_TITLE, { exact: true }),
    ).not.toBeVisible({ timeout: 10_000 })
  } finally {
    await context.close()
  }
})
