import { chromium, expect, test, type Page } from '@playwright/test'
import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

// P5D-S1 — Tag V1 browser parity.
//
// Drives the *real* Task Tag lifecycle end-to-end through the product UI:
//   create tag -> create task -> assign tag -> filter -> reload persistence
//   -> rename (relation survives) -> remove relation (entity survives)
//   -> final reload.
//
// Every transition goes through the React UI -> services -> repositories ->
// shared Worker -> sqlite-wasm -> isolated OPFS. No harness / direct service
// calls. Scope is frozen to Task-only Tag V1 (per architecture review);
// out-of-scope Tag features (delete / color / merge / cross-domain) are
// intentionally NOT exercised here.

const TAG_NAME = 'S1TAG'
const TAG_RENAMED = 'S1TAG_RENAMED'
const TASK_A = 'S1 Task Alpha'
const TASK_B = 'S1 Task Bravo'

test('persists Task Tag lifecycle through the real UI and OPFS', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const configuredBaseURL = testInfo.project.use.baseURL
  if (typeof configuredBaseURL !== 'string') {
    throw new Error('Playwright baseURL is required.')
  }
  const baseURL = configuredBaseURL

  const profilePath = testInfo.outputPath('browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) {
    throw new Error('Refusing to use an unowned browser profile path.')
  }

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
  })
  try {
    const page = await context.newPage()

    await page.goto(`${baseURL}/tasks`)
    await expect(page.getByLabel('搜索任务')).toBeVisible({ timeout: 30_000 })

    // Create a Tag through the Tasks UI.
    await page.getByRole('button', { name: '标签管理' }).click()
    await page.getByRole('menuitem', { name: '新建标签' }).click()
    await page.getByRole('textbox', { name: '标签名称' }).fill(TAG_NAME)
    await page.getByRole('button', { name: '创建标签' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Create Task A.
    await createTask(page, TASK_A)

    // Assign the Tag to Task A, then re-open to prove it persisted in session.
    await openTaskDetail(page, TASK_A)
    await page.getByRole('button', { name: `添加标签：${TAG_NAME}` }).click()
    await expect(
      page.getByRole('button', { name: `移除标签：${TAG_NAME}` }),
    ).toBeVisible()
    await closeTaskDetail(page)
    await openTaskDetail(page, TASK_A)
    await expect(
      page.getByRole('button', { name: `移除标签：${TAG_NAME}` }),
    ).toBeVisible()
    await closeTaskDetail(page)

    // An untagged control task proves the filter actually discriminates.
    await createTask(page, TASK_B)
    await assertTagFilter(page, TAG_NAME, TASK_A, TASK_B)

    // Reload: tag + relation survive an OPFS-backed page reload.
    await reloadTasks(page)
    await openTaskDetail(page, TASK_A)
    await expect(
      page.getByRole('button', { name: `移除标签：${TAG_NAME}` }),
    ).toBeVisible()
    await closeTaskDetail(page)
    await assertTagFilter(page, TAG_NAME, TASK_A, TASK_B)

    // Rename: the relation must follow the tag to its new name.
    await page.getByRole('button', { name: '标签管理' }).click()
    await page
      .getByRole('menuitem', { name: `重命名标签：${TAG_NAME}` })
      .click()
    await page.getByRole('textbox', { name: '标签名称' }).fill(TAG_RENAMED)
    await page.getByRole('button', { name: '保存名称' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await openTaskDetail(page, TASK_A)
    await expect(
      page.getByRole('button', { name: `移除标签：${TAG_RENAMED}` }),
    ).toBeVisible()
    await closeTaskDetail(page)
    await assertTagFilter(page, TAG_RENAMED, TASK_A, TASK_B)

    // Remove the relation: Task A stays, the Tag entity stays.
    await openTaskDetail(page, TASK_A)
    await page
      .getByRole('button', { name: `移除标签：${TAG_RENAMED}` })
      .click()
    await expect(
      page.getByRole('button', { name: `添加标签：${TAG_RENAMED}` }),
    ).toBeVisible()
    await closeTaskDetail(page)
    // The tag entity still exists (still selectable), and Task A is now
    // excluded from its filter.
    await page.getByRole('button', { name: /^筛选/ }).click()
    await page.getByRole('combobox', { name: '筛选标签' }).selectOption({
      label: TAG_RENAMED,
    })
    await expect(
      page.getByRole('button', { name: `查看任务详情：${TASK_A}` }),
    ).toHaveCount(0)
    await page
      .getByRole('button', { name: `清除筛选：标签：${TAG_RENAMED}` })
      .click()
    await page.getByRole('button', { name: /^筛选/ }).click()

    // Final reload: relation removal persisted, tag still assignable.
    await reloadTasks(page)
    await openTaskDetail(page, TASK_A)
    await expect(
      page.getByRole('button', { name: `添加标签：${TAG_RENAMED}` }),
    ).toBeVisible()
    await closeTaskDetail(page)
  } finally {
    await context.close()
    await rm(resolvedProfile, { recursive: true, force: true })
  }
})

async function createTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '新建任务' }).first().click()
  await expect(page.getByRole('dialog', { name: '新建任务' })).toBeVisible()
  await page.getByRole('textbox', { name: '标题' }).fill(title)
  await page.getByRole('button', { name: '创建任务' }).click()
  await expect(page.getByRole('dialog', { name: '新建任务' })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: `查看任务详情：${title}` }),
  ).toBeVisible()
}

async function reloadTasks(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByLabel('搜索任务')).toBeVisible({ timeout: 30_000 })
}

async function openTaskDetail(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `查看任务详情：${title}` }).click()
  await expect(page.getByRole('dialog', { name: /^任务详情：/ })).toBeVisible()
}

async function closeTaskDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(
    page.getByRole('dialog', { name: /^任务详情：/ }),
  ).toHaveCount(0)
}

async function assertTagFilter(
  page: Page,
  tagName: string,
  visibleTitle: string,
  hiddenTitle: string,
): Promise<void> {
  await page.getByRole('button', { name: /^筛选/ }).click()
  await page.getByRole('combobox', { name: '筛选标签' }).selectOption({
    label: tagName,
  })
  await expect(
    page.getByRole('button', { name: `查看任务详情：${visibleTitle}` }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: `查看任务详情：${hiddenTitle}` }),
  ).toHaveCount(0)
  // Reset the tag filter via its clear chip, then close the panel.
  await page
    .getByRole('button', { name: `清除筛选：标签：${tagName}` })
    .click()
  await page.getByRole('button', { name: /^筛选/ }).click()
}
