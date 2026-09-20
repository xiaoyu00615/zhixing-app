import { chromium, expect, test } from '@playwright/test'

const DIARY_TITLE = 'E2E Diary · Title'
const DIARY_CONTENT = '# E2E Diary\n\n第一行\n  leading spaces\n最后一行 ✓\n\n日本語テスト'
const DIARY_CONTENT_UPDATED = 'E2E Diary · updated content'

test('persists Diary create / edit / reload / delete in real OPFS', async ({
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

    // ---- OPEN /diary DIRECTLY (no harness navigation) ----
    await page.goto(`${configuredBaseURL}/diary`)
    // Wait for the page to be ready (phase === 'ready')
    await page.getByRole('heading', { name: '日记', level: 2 }).waitFor({ timeout: 30_000 })
    await expect(page.getByRole('status', { name: '正在加载日记' })).not.toBeVisible()

    // Wait for the create button to be enabled (service ready)
    await page.waitForSelector('button:has-text("新建日记"):not([disabled])', { timeout: 30_000 })

    // ---- OPEN CREATE-DATE PICKER, USE TODAY, CREATE ----
    const headerCreateBtn = page.locator('header').getByRole('button', { name: '新建日记' })
    await expect(headerCreateBtn).toBeEnabled()
    await headerCreateBtn.click()

    const dateInput = page.getByLabel('选择日记日期')
    await expect(dateInput).toBeVisible({ timeout: 10_000 })
    await expect(dateInput).not.toBeDisabled()
    await page.getByRole('button', { name: '创建' }).click()

    // Wait for the editor to be ready
    const titleInput = page.getByLabel('日记标题')
    await expect(titleInput).toBeVisible({ timeout: 30_000 })

    // ---- EDIT TITLE ----
    await titleInput.fill(DIARY_TITLE)

    // ---- EDIT CONTENT ----
    const contentTextarea = page.getByLabel('日记正文')
    await contentTextarea.fill(DIARY_CONTENT)

    // ---- WAIT FOR AUTOSAVE ----
    await page.getByText('已保存', { exact: false }).waitFor({ timeout: 30_000 })

    // ---- FIRST RELOAD ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: '日记', level: 2 }).waitFor({ timeout: 15_000 })

    // Find and select the diary entry
    const diaryList = page.getByRole('list', { name: '日记列表' })
    await diaryList.waitFor({ timeout: 10_000 })
    const diaryItem = diaryList.getByText(DIARY_TITLE, { exact: true })
    await expect(diaryItem).toBeVisible({ timeout: 10_000 })
    await diaryItem.click()

    // Verify editor fields persisted
    await expect(titleInput).toHaveValue(DIARY_TITLE)
    await expect(contentTextarea).toHaveValue(DIARY_CONTENT)

    // ---- MODIFY CONTENT ----
    await contentTextarea.fill(DIARY_CONTENT_UPDATED)

    // ---- WAIT FOR AUTOSAVE AGAIN ----
    await page.getByText('已保存', { exact: false }).waitFor({ timeout: 30_000 })

    // ---- SECOND RELOAD ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: '日记', level: 2 }).waitFor({ timeout: 15_000 })

    const diaryListAfter = page.getByRole('list', { name: '日记列表' })
    await diaryListAfter.waitFor({ timeout: 10_000 })
    await diaryListAfter.getByText(DIARY_TITLE, { exact: true }).click()

    // Verify the update persisted
    await expect(titleInput).toHaveValue(DIARY_TITLE)
    await expect(contentTextarea).toHaveValue(DIARY_CONTENT_UPDATED)

    // ---- DELETE DIARY ----
    await page.getByRole('button', { name: '删除' }).click()
    await page.getByRole('button', { name: '确认删除' }).click()

    // Wait for the entry to disappear from the list
    await expect(diaryListAfter.getByText(DIARY_TITLE, { exact: true })).not.toBeVisible({
      timeout: 10_000,
    })

    // ---- THIRD RELOAD ----
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: '日记', level: 2 }).waitFor({ timeout: 15_000 })

    // Verify the deleted entry is gone
    const diaryListFinal = page.getByRole('list', { name: '日记列表' })
    void diaryListFinal
    await expect(
      page.getByText(DIARY_TITLE, { exact: true }),
    ).not.toBeVisible({ timeout: 10_000 })
  } finally {
    await context.close()
  }
})
