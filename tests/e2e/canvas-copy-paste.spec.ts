import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface CanvasRecordLike {
  readonly id: string
  readonly nodeName?: string
  readonly type?: string
  readonly x?: number
  readonly y?: number
}

interface EdgeRecordLike {
  readonly id: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType?: string
  readonly direction?: string
  readonly lineStyle?: string
  readonly membershipPosition?: number | null
  readonly deletedAtMs?: number | null
}

type HarnessWindow = Window & {
  __taskPersistenceHarness: {
    createCanvas(input: unknown): Promise<unknown>
    createTextNode(input: unknown): Promise<unknown>
    createCanvasNode(input: unknown): Promise<unknown>
    createCanvasEdge(input: unknown): Promise<unknown>
    addCanvasNodeBoxMember(input: unknown): Promise<unknown>
    listCanvasNodes(canvasId: string): Promise<readonly CanvasRecordLike[]>
    listCanvasEdges(canvasId: string): Promise<readonly EdgeRecordLike[]>
    shutdown(): Promise<void>
  }
}

const COPIES_CANVAS_ID = '00000000-0000-4000-8000-000000002001'
const COPIES_TEXT_A_ID = '00000000-0000-4000-8000-000000002002'
const COPIES_STICKY_B_ID = '00000000-0000-4000-8000-000000002003'
const COPIES_TEXT_C_ID = '00000000-0000-4000-8000-000000002004'
const COPIES_EDGE_AB_ID = '00000000-0000-4000-8000-000000002005'
const COPIES_EDGE_BC_ID = '00000000-0000-4000-8000-000000002006'
const LEGACY_CANVAS_ID = '00000000-0000-4000-8000-000000002007'
const LEGACY_TEXT_A_ID = '00000000-0000-4000-8000-000000002008'
const LEGACY_BOX_X_ID = '00000000-0000-4000-8000-000000002009'
const LEGACY_MEMBERSHIP_EDGE_ID = '00000000-0000-4000-8000-00000000200a'

// Slice 10B fixtures.
const BOX_ONLY_CANVAS_ID = '00000000-0000-4000-8000-000000002101'
const BOX_ONLY_BOX_ID = '00000000-0000-4000-8000-000000002102'
const BOX_ONLY_MEMBER_ID = '00000000-0000-4000-8000-000000002103'
const BOX_ONLY_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000002104'
const ORDERED_CANVAS_ID = '00000000-0000-4000-8000-000000002111'
const ORDERED_BOX_ID = '00000000-0000-4000-8000-000000002112'
const ORDERED_A_ID = '00000000-0000-4000-8000-000000002113'
const ORDERED_B_ID = '00000000-0000-4000-8000-000000002114'
const ORDERED_C_ID = '00000000-0000-4000-8000-000000002115'
const MIXED_CANVAS_ID = '00000000-0000-4000-8000-000000002121'
const MIXED_BOX_ID = '00000000-0000-4000-8000-000000002122'
const MIXED_A_ID = '00000000-0000-4000-8000-000000002123'
const MIXED_C_ID = '00000000-0000-4000-8000-000000002124'
const MEMBER_ONLY_CANVAS_ID = '00000000-0000-4000-8000-000000002131'
const MEMBER_ONLY_BOX_ID = '00000000-0000-4000-8000-000000002132'
const MEMBER_ONLY_A_ID = '00000000-0000-4000-8000-000000002133'
const MEMBER_ONLY_B_ID = '00000000-0000-4000-8000-000000002134'
const HIERARCHY_CANVAS_ID = '00000000-0000-4000-8000-000000002141'
const HIERARCHY_BOX_ID = '00000000-0000-4000-8000-000000002142'
const HIERARCHY_A_ID = '00000000-0000-4000-8000-000000002143'
const HIERARCHY_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000002144'
const HIERARCHY_EDGE_ID = '00000000-0000-4000-8000-000000002145'
const TWO_BOX_CANVAS_ID = '00000000-0000-4000-8000-000000002151'
const TWO_BOX_X_ID = '00000000-0000-4000-8000-000000002152'
const TWO_BOX_Y_ID = '00000000-0000-4000-8000-000000002153'
const TWO_BOX_A_ID = '00000000-0000-4000-8000-000000002154'
const TWO_BOX_B_ID = '00000000-0000-4000-8000-000000002155'
const REPEAT_CANVAS_ID = '00000000-0000-4000-8000-000000002161'
const REPEAT_BOX_ID = '00000000-0000-4000-8000-000000002162'
const REPEAT_MEMBER_ID = '00000000-0000-4000-8000-000000002163'
const RESTART_10B_CANVAS_ID = '00000000-0000-4000-8000-000000002171'
const RESTART_10B_BOX_ID = '00000000-0000-4000-8000-000000002172'
const RESTART_10B_A_ID = '00000000-0000-4000-8000-000000002173'
const RESTART_10B_C_ID = '00000000-0000-4000-8000-000000002174'
const ORDERED_MEMBERSHIP_A_ID = '00000000-0000-4000-8000-000000002116'
const ORDERED_MEMBERSHIP_B_ID = '00000000-0000-4000-8000-000000002117'
const ORDERED_MEMBERSHIP_C_ID = '00000000-0000-4000-8000-000000002118'
const MIXED_MEMBERSHIP_A_ID = '00000000-0000-4000-8000-000000002125'
const MIXED_MEMBERSHIP_C_ID = '00000000-0000-4000-8000-000000002126'
const MEMBER_ONLY_MEMBERSHIP_A_ID = '00000000-0000-4000-8000-000000002135'
const MEMBER_ONLY_MEMBERSHIP_B_ID = '00000000-0000-4000-8000-000000002136'
const TWO_BOX_MEMBERSHIP_A_ID = '00000000-0000-4000-8000-000000002156'
const TWO_BOX_MEMBERSHIP_B_ID = '00000000-0000-4000-8000-000000002157'
const REPEAT_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000002164'
const RESTART_10B_MEMBERSHIP_A_ID = '00000000-0000-4000-8000-000000002175'
const RESTART_10B_MEMBERSHIP_C_ID = '00000000-0000-4000-8000-000000002176'
const RESTART_10B_HIERARCHY_ID = '00000000-0000-4000-8000-000000002177'

async function openHarnessPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/tests/e2e/persistence.html`)
  await page.waitForFunction(() => '__taskPersistenceHarness' in window)
  return page
}

function nodeLocator(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`)
}

async function readNodeIds(page: Page): Promise<string[]> {
  return page.locator('.react-flow__node').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.id ?? ''),
  )
}

async function readEdgeIds(page: Page): Promise<string[]> {
  return page.locator('.react-flow__edge').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.id ?? ''),
  )
}

function uniqueIds(ids: readonly string[]): Set<string> {
  return new Set(ids)
}

async function expectEdgeRendered(page: Page, edgeId: string): Promise<void> {
  const edge = page.locator(`.react-flow__edge[data-id="${edgeId}"]`)
  await expect(edge).toHaveCount(1)
  // React Flow v12 renders an edge <g> only after both endpoint nodes are
  // measured, so DOM presence implies valid endpoint geometry. A straight
  // horizontal edge has a zero-height bounding rect, so isVisible() would
  // reject perfectly rendered edges; assert style visibility, path geometry,
  // and painted bounds instead.
  await expect
    .poll(
      () => edge.evaluate((element) => {
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none'
      }),
      { timeout: 15_000 },
    )
    .toBe(true)
  await expect
    .poll(async () => {
      const path = edge.locator('.react-flow__edge-path').first()
      if (await path.count() === 0) return ''
      return (await path.getAttribute('d')) ?? ''
    }, { timeout: 15_000 })
    .not.toBe('')
  await expect.poll(async () => await edge.boundingBox() !== null, { timeout: 15_000 }).toBe(true)
}

async function ctrlC(page: Page): Promise<void> {
  await page.keyboard.down('Control')
  await page.keyboard.press('c')
  await page.keyboard.up('Control')
}

async function ctrlV(page: Page): Promise<void> {
  await page.keyboard.down('Control')
  await page.keyboard.press('v')
  await page.keyboard.up('Control')
}

async function openCanvasEditor(context: BrowserContext, baseURL: string, canvasId: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/canvas/${canvasId}`)
  return page
}

interface PersistedFixture {
  readonly nodes: readonly CanvasRecordLike[]
  readonly edges: readonly EdgeRecordLike[]
}

async function readPersistedFixture(
  context: BrowserContext,
  baseURL: string,
  canvasId: string,
): Promise<PersistedFixture> {
  const page = await openHarnessPage(context, baseURL)
  return page.evaluate(async (id) => {
    const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
    return { nodes: await harness.listCanvasNodes(id), edges: await harness.listCanvasEdges(id) }
  }, canvasId)
}

function safeProfilePath(testInfo: TestInfo, name: string): string {
  const profilePath = testInfo.outputPath(name)
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')
  return profilePath
}

function launchProfile(profilePath: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1920, height: 1080 },
  })
}

async function seedFixture<T>(
  context: BrowserContext,
  baseURL: string,
  arg: T,
  seed: (fixture: T) => Promise<void>,
): Promise<void> {
  const page = await openHarnessPage(context, baseURL)
  await page.evaluate(seed as (fixture: unknown) => Promise<void>, arg)
}

function requireChromiumBaseUrl(browserName: string, baseURL: string | undefined): string {
  expect(browserName).toBe('chromium')
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  return baseURL
}

test('copies a single Text node and pastes it with +32 offset', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-single-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, nodeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Copy Single Test', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: nodeId, canvasId, nodeName: 'SingleText', content: { type: 'text', text: 'Copy Me' }, x: 200, y: 200, createdAtMs: 110 })
      await harness.shutdown()
    }, { canvasId: COPIES_CANVAS_ID, nodeId: COPIES_TEXT_A_ID })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: 'Copy Single Test' })).toBeVisible()
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    await expect(nodeA).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(uniqueIds(beforeIds).size).toBe(beforeIds.length)
    expect(beforeIds).toEqual([COPIES_TEXT_A_ID])

    await nodeA.click({ position: { x: 80, y: 18 } })
    await expect(nodeA).toHaveClass(/selected/)

    await ctrlC(editor)
    const copyStatus = editor.locator('[role="status"]')
    await expect(copyStatus).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(copyStatus).toHaveText('已粘贴 1 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(2)
    expect(new Set(afterIds)).toContain(COPIES_TEXT_A_ID)
    const newIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(newIds).toHaveLength(1)
    const pastedNodeId = newIds[0]!

    const pastedNode = nodeLocator(editor, pastedNodeId)
    await expect(pastedNode).toHaveClass(/selected/)
    await expect(nodeA).not.toHaveClass(/selected/)
    await expect(pastedNode.getByText('Copy Me')).toBeVisible()
    await expect(pastedNode.getByText('SingleText')).toBeVisible()
    await editor.screenshot({ path: testInfo.outputPath('10A-01-single-paste.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('copies Text + Sticky with internal Edge and preserves edge semantics on paste', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-edge-semantic-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, textId, stickyId, edgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Copy Edge Semantic', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: textId, canvasId, nodeName: 'Parent', content: { type: 'text', text: '规划' }, x: 200, y: 200, createdAtMs: 110 })
      await harness.createCanvasNode({ id: stickyId, canvasId, type: 'sticky', nodeName: 'Child', content: { type: 'sticky', text: '待办' }, x: 400, y: 300, createdAtMs: 120 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: textId, targetNodeId: stickyId, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed', createdAtMs: 130 })
      await harness.shutdown()
    }, { canvasId: COPIES_CANVAS_ID, textId: COPIES_TEXT_A_ID, stickyId: COPIES_STICKY_B_ID, edgeId: COPIES_EDGE_AB_ID })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: 'Copy Edge Semantic' })).toBeVisible()
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    const nodeB = nodeLocator(editor, COPIES_STICKY_B_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(uniqueIds(beforeIds).size).toBe(beforeIds.length)
    expect(beforeIds).toHaveLength(2)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await nodeB.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)

    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(4)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(2)
    const [pastedAId, pastedBId] = pastedIds
    if (pastedAId === undefined || pastedBId === undefined) throw new Error('Expected two pasted node IDs.')

    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()
    await expect(nodeA).not.toHaveClass(/selected/)
    await expect(nodeB).not.toHaveClass(/selected/)
    await expect(nodeLocator(editor, pastedAId)).toHaveClass(/selected/)
    await expect(nodeLocator(editor, pastedBId)).toHaveClass(/selected/)

    const edgeIds = await readEdgeIds(editor)
    expect(uniqueIds(edgeIds).size).toBe(edgeIds.length)
    expect(edgeIds).toHaveLength(2)
    expect(new Set(edgeIds)).toContain(COPIES_EDGE_AB_ID)
    const pastedEdgeId = edgeIds.find((id) => id !== COPIES_EDGE_AB_ID)!
    expect(pastedEdgeId).not.toBe(COPIES_EDGE_AB_ID)

    await expectEdgeRendered(editor, COPIES_EDGE_AB_ID)
    await expectEdgeRendered(editor, pastedEdgeId)
    await editor.screenshot({ path: testInfo.outputPath('10A-02-multi-edge-paste.png') })

    // Persistence-layer semantics: navigate back to the harness page and read
    // the durable records (the editor worker releases OPFS on navigation).
    const harnessPage = await openHarnessPage(context, baseURL)
    const persisted = await harnessPage.evaluate(async ({ canvasId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return { nodes: await harness.listCanvasNodes(canvasId), edges: await harness.listCanvasEdges(canvasId) }
    }, { canvasId: COPIES_CANVAS_ID })

    expect(persisted.nodes).toHaveLength(4)
    const pastedNodes = persisted.nodes.filter((node) => pastedIds.includes(node.id))
    expect(pastedNodes).toHaveLength(2)
    expect(new Set(pastedNodes.map((node) => node.type))).toEqual(new Set(['text', 'sticky']))
    const originalById = new Map(persisted.nodes.filter((node) => beforeIds.includes(node.id)).map((node) => [node.id, node]))
    for (const pastedNode of pastedNodes) {
      const source = originalById.get(
        pastedIds[0] === pastedNode.id
          ? COPIES_TEXT_A_ID
          : COPIES_STICKY_B_ID,
      )
      if (pastedNode.type === source?.type) {
        expect(pastedNode.nodeName).toBe(source.nodeName)
      }
    }

    expect(persisted.edges).toHaveLength(2)
    const originalEdge = persisted.edges.find((edge) => edge.id === COPIES_EDGE_AB_ID)!
    expect(originalEdge).toMatchObject({
      id: COPIES_EDGE_AB_ID,
      sourceNodeId: COPIES_TEXT_A_ID,
      targetNodeId: COPIES_STICKY_B_ID,
      relationType: 'hierarchy',
      direction: 'bidirectional',
      lineStyle: 'dashed',
    })
    const pastedEdge = persisted.edges.find((edge) => edge.id === pastedEdgeId)!
    expect(pastedEdge).toMatchObject({
      relationType: 'hierarchy',
      direction: 'bidirectional',
      lineStyle: 'dashed',
    })
    expect(pastedEdge.sourceNodeId).toBe(pastedIds.find((id) => persisted.nodes.find((node) => node.id === id)?.type === 'text'))
    expect(pastedEdge.targetNodeId).toBe(pastedIds.find((id) => persisted.nodes.find((node) => node.id === id)?.type === 'sticky'))
    await harnessPage.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown())
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('excludes external edges when only a subset of nodes is copied', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-external-edge-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, aId, bId, cId, edgeAbId, edgeBcId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'External Edge Exclusion', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: aId, canvasId, nodeName: 'A', content: { type: 'text', text: 'A' }, x: 100, y: 200, createdAtMs: 110 })
      await harness.createTextNode({ id: bId, canvasId, nodeName: 'B', content: { type: 'text', text: 'B' }, x: 400, y: 200, createdAtMs: 120 })
      await harness.createTextNode({ id: cId, canvasId, nodeName: 'C', content: { type: 'text', text: 'C' }, x: 700, y: 200, createdAtMs: 130 })
      await harness.createCanvasEdge({ id: edgeAbId, canvasId, sourceNodeId: aId, targetNodeId: bId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 140 })
      await harness.createCanvasEdge({ id: edgeBcId, canvasId, sourceNodeId: bId, targetNodeId: cId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 150 })
      await harness.shutdown()
    }, {
      canvasId: COPIES_CANVAS_ID,
      aId: COPIES_TEXT_A_ID,
      bId: COPIES_STICKY_B_ID,
      cId: COPIES_TEXT_C_ID,
      edgeAbId: COPIES_EDGE_AB_ID,
      edgeBcId: COPIES_EDGE_BC_ID,
    })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: 'External Edge Exclusion' })).toBeVisible()
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    const nodeB = nodeLocator(editor, COPIES_STICKY_B_ID)
    const nodeC = nodeLocator(editor, COPIES_TEXT_C_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()
    await expect(nodeC).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(uniqueIds(beforeIds).size).toBe(beforeIds.length)
    expect(beforeIds).toHaveLength(3)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await nodeB.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)
    await expect(nodeC).not.toHaveClass(/selected/)

    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(5)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(2)

    const edgeIds = await readEdgeIds(editor)
    expect(uniqueIds(edgeIds).size).toBe(edgeIds.length)
    expect(edgeIds).toHaveLength(3)
    expect(new Set(edgeIds)).toContain(COPIES_EDGE_AB_ID)
    expect(new Set(edgeIds)).toContain(COPIES_EDGE_BC_ID)
    const pastedEdgeId = edgeIds.find((id) => id !== COPIES_EDGE_AB_ID && id !== COPIES_EDGE_BC_ID)!
    await expectEdgeRendered(editor, COPIES_EDGE_AB_ID)
    await expectEdgeRendered(editor, COPIES_EDGE_BC_ID)
    await expectEdgeRendered(editor, pastedEdgeId)
    await editor.screenshot({ path: testInfo.outputPath('10A-04-external-edge.png') })

    // Persistence semantics: original A→B and B→C remain active, the pasted
    // edge connects A'→B', and no cross edge exists in any direction.
    const harnessPage = await openHarnessPage(context, baseURL)
    const persistedEdges = await harnessPage.evaluate(
      (canvasId) => (window as unknown as HarnessWindow).__taskPersistenceHarness.listCanvasEdges(canvasId),
      COPIES_CANVAS_ID,
    )
    expect(persistedEdges).toHaveLength(3)
    const edgeById = new Map(persistedEdges.map((edge) => [edge.id, edge]))
    expect(edgeById.get(COPIES_EDGE_AB_ID)).toMatchObject({ sourceNodeId: COPIES_TEXT_A_ID, targetNodeId: COPIES_STICKY_B_ID })
    expect(edgeById.get(COPIES_EDGE_BC_ID)).toMatchObject({ sourceNodeId: COPIES_STICKY_B_ID, targetNodeId: COPIES_TEXT_C_ID })
    const pastedEdge = edgeById.get(pastedEdgeId)!
    expect(pastedEdge).toBeDefined()
    expect([pastedEdge.sourceNodeId, pastedEdge.targetNodeId].sort()).toEqual([...pastedIds].sort())
    const allNodeIds = new Set([...beforeIds, ...pastedIds])
    expect(allNodeIds.has(pastedEdge.sourceNodeId)).toBe(true)
    expect(allNodeIds.has(pastedEdge.targetNodeId)).toBe(true)
    // No original↔pasted cross edge of any kind.
    for (const edge of persistedEdges) {
      const crosses = beforeIds.includes(edge.sourceNodeId) !== beforeIds.includes(edge.targetNodeId)
      expect(crosses).toBe(false)
    }
    await harnessPage.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown())
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('repeated paste increments offset by +32 each time', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-offset-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, aId, bId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Offset Test', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: aId, canvasId, nodeName: 'X', content: { type: 'text', text: 'X' }, x: 200, y: 200, createdAtMs: 110 })
      await harness.createCanvasNode({ id: bId, canvasId, type: 'sticky', nodeName: 'Y', content: { type: 'sticky', text: 'Y' }, x: 400, y: 300, createdAtMs: 120 })
      await harness.shutdown()
    }, { canvasId: COPIES_CANVAS_ID, aId: COPIES_TEXT_A_ID, bId: COPIES_STICKY_B_ID })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: 'Offset Test' })).toBeVisible()
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    const nodeB = nodeLocator(editor, COPIES_STICKY_B_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    const beforeIds = await readNodeIds(editor)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await nodeB.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')
    let afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(4)
    const firstPasteIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(firstPasteIds).toHaveLength(2)
    const firstPasteTransforms = await Promise.all(firstPasteIds.map(async (id) =>
      (await nodeLocator(editor, id).getAttribute('style')) ?? '',
    ))

    await ctrlV(editor)
    // The status text is identical for both pastes, so it cannot signal
    // completion of the second one; wait for the DOM node count instead.
    await expect
      .poll(() => readNodeIds(editor), { timeout: 15_000 })
      .toHaveLength(6)
    afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(6)
    const secondPasteIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id) && !firstPasteIds.includes(id))
    expect(secondPasteIds).toHaveLength(2)
    const secondPasteTransforms = await Promise.all(secondPasteIds.map(async (id) =>
      (await nodeLocator(editor, id).getAttribute('style')) ?? '',
    ))
    const firstPasteTransformSet = new Set(firstPasteTransforms)
    expect(secondPasteTransforms.filter((transform) => firstPasteTransformSet.has(transform))).toHaveLength(0)
    await editor.screenshot({ path: testInfo.outputPath('10A-03-repeated-paste.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('editable guard: Ctrl+C/V in text input does not trigger canvas copy/paste', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-editable-guard-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, nodeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Editable Guard', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: nodeId, canvasId, nodeName: 'GuardTest', content: { type: 'text', text: 'editable content' }, x: 300, y: 300, createdAtMs: 110 })
      await harness.shutdown()
    }, { canvasId: COPIES_CANVAS_ID, nodeId: COPIES_TEXT_A_ID })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    await expect(nodeA).toBeVisible()

    const contentEdit = nodeA.getByLabel('文字节点内容')
    await expect(contentEdit).toBeVisible()
    await contentEdit.dblclick()
    await editor.waitForTimeout(200)

    const activeTagName = await editor.evaluate(() => document.activeElement?.tagName ?? 'NONE')
    expect(['INPUT', 'TEXTAREA', 'DIV'].includes(activeTagName.toUpperCase()) || activeTagName === 'CONTENTEDITABLE').toBeTruthy()

    await editor.keyboard.down('Control')
    await editor.keyboard.press('a')
    await editor.keyboard.up('Control')
    await editor.keyboard.down('Control')
    await editor.keyboard.press('c')
    await editor.keyboard.up('Control')
    await editor.keyboard.down('Control')
    await editor.keyboard.press('v')
    await editor.keyboard.up('Control')
    await editor.waitForTimeout(300)

    const nodeIds = await readNodeIds(editor)
    expect(uniqueIds(nodeIds).size).toBe(1)
    expect(new Set(nodeIds)).toEqual(new Set([COPIES_TEXT_A_ID]))
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('paste persistence survives browser restart', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-restart-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    let page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, aId, bId, edgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Restart Persistence', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: aId, canvasId, nodeName: 'SourceA', content: { type: 'text', text: 'Alpha' }, x: 200, y: 200, createdAtMs: 110 })
      await harness.createCanvasNode({ id: bId, canvasId, type: 'sticky', nodeName: 'SourceB', content: { type: 'sticky', text: 'Beta' }, x: 400, y: 300, createdAtMs: 120 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: aId, targetNodeId: bId, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed', createdAtMs: 130 })
      await harness.shutdown()
    }, { canvasId: COPIES_CANVAS_ID, aId: COPIES_TEXT_A_ID, bId: COPIES_STICKY_B_ID, edgeId: COPIES_EDGE_AB_ID })

    const editor = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    const nodeA = nodeLocator(editor, COPIES_TEXT_A_ID)
    const nodeB = nodeLocator(editor, COPIES_STICKY_B_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    await nodeA.click({ position: { x: 80, y: 18 } })
    await nodeB.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(4)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(2)
    const edgeIdsBeforeRestart = await readEdgeIds(editor)
    expect(edgeIdsBeforeRestart).toHaveLength(2)
    expect(new Set(edgeIdsBeforeRestart)).toContain(COPIES_EDGE_AB_ID)
    const pastedEdgeIdBeforeRestart = edgeIdsBeforeRestart.find((id) => id !== COPIES_EDGE_AB_ID)!

    // Same restart lifecycle as canvas-persistence.spec.ts: fully close the
    // context, then relaunch the SAME profile before opening anything new.
    await context.close()
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    page = await openHarnessPage(context, baseURL)
    const restored = await page.evaluate(async ({ canvasId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return { nodes: await harness.listCanvasNodes(canvasId), edges: await harness.listCanvasEdges(canvasId) }
    }, { canvasId: COPIES_CANVAS_ID })

    expect(restored.nodes).toHaveLength(4)
    expect(new Set(restored.nodes.map((node) => node.id))).toEqual(new Set([...beforeIds, ...pastedIds]))
    expect(restored.edges).toHaveLength(2)
    expect(new Set(restored.edges.map((edge) => edge.id))).toEqual(
      new Set([COPIES_EDGE_AB_ID, pastedEdgeIdBeforeRestart]),
    )
    const restoredEdgeById = new Map(restored.edges.map((edge) => [edge.id, edge]))
    expect(restoredEdgeById.get(COPIES_EDGE_AB_ID)).toMatchObject({
      sourceNodeId: COPIES_TEXT_A_ID,
      targetNodeId: COPIES_STICKY_B_ID,
      relationType: 'hierarchy',
      direction: 'bidirectional',
      lineStyle: 'dashed',
    })
    expect(restoredEdgeById.get(pastedEdgeIdBeforeRestart)).toMatchObject({
      relationType: 'hierarchy',
      direction: 'bidirectional',
      lineStyle: 'dashed',
    })
    await page.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown())

    const editorAfterRestart = await openCanvasEditor(context, baseURL, COPIES_CANVAS_ID)
    await expect(editorAfterRestart.getByRole('heading', { name: 'Restart Persistence' })).toBeVisible()
    const nodeIdsAfterRestart = await readNodeIds(editorAfterRestart)
    expect(uniqueIds(nodeIdsAfterRestart).size).toBe(4)
    expect(new Set(nodeIdsAfterRestart)).toEqual(new Set([...beforeIds, ...pastedIds]))
    await expect(nodeLocator(editorAfterRestart, COPIES_TEXT_A_ID).getByText('Alpha')).toBeVisible()
    await expect(nodeLocator(editorAfterRestart, COPIES_STICKY_B_ID).getByText('Beta')).toBeVisible()
    const edgeIdsAfterRestart = await readEdgeIds(editorAfterRestart)
    expect(new Set(edgeIdsAfterRestart)).toEqual(new Set([COPIES_EDGE_AB_ID, pastedEdgeIdBeforeRestart]))
    await expectEdgeRendered(editorAfterRestart, COPIES_EDGE_AB_ID)
    await expectEdgeRendered(editorAfterRestart, pastedEdgeIdBeforeRestart)
    await editorAfterRestart.screenshot({ path: testInfo.outputPath('10A-05-restart.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('legacy canvas with membership edge still copies and pastes supported nodes', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-copy-legacy-membership-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    // Legacy fixture mirrors the real user canvas 新测试: a Text member A
    // attached to a Node Box X through an ordered membership edge.
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, textId, boxId, edgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Legacy Membership', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: textId, canvasId, nodeName: 'MemberA', content: { type: 'text', text: 'Legacy Member' }, x: 200, y: 200, createdAtMs: 110 })
      await harness.createCanvasNode({ id: boxId, canvasId, type: 'node_box', nodeName: '', content: { type: 'node_box' }, x: 600, y: 400, createdAtMs: 120 })
      await harness.addCanvasNodeBoxMember({ id: edgeId, canvasId, sourceNodeId: textId, targetNodeId: boxId, relationType: 'ordered_box_member', createdAtMs: 130 })
      await harness.shutdown()
    }, { canvasId: LEGACY_CANVAS_ID, textId: LEGACY_TEXT_A_ID, boxId: LEGACY_BOX_X_ID, edgeId: LEGACY_MEMBERSHIP_EDGE_ID })

    const editor = await openCanvasEditor(context, baseURL, LEGACY_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: 'Legacy Membership' })).toBeVisible()
    const nodeA = nodeLocator(editor, LEGACY_TEXT_A_ID)
    const nodeX = nodeLocator(editor, LEGACY_BOX_X_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeX).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(2)

    // Select only the Text member A and copy it on this membership canvas.
    await nodeA.click({ position: { x: 80, y: 18 } })
    await expect(nodeA).toHaveClass(/selected/)
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 1 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(3)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(1)
    const pastedNodeId = pastedIds[0]!

    // Node Box is not copied; no membership edge is duplicated.
    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toEqual([LEGACY_MEMBERSHIP_EDGE_ID])
    await expectEdgeRendered(editor, LEGACY_MEMBERSHIP_EDGE_ID)

    // Persistence layer: exactly one Text member added; box and membership untouched.
    await context.close()
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    const verifyPage = await openHarnessPage(context, baseURL)
    const restored = await verifyPage.evaluate(async ({ canvasId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return { nodes: await harness.listCanvasNodes(canvasId), edges: await harness.listCanvasEdges(canvasId) }
    }, { canvasId: LEGACY_CANVAS_ID })
    expect(restored.nodes).toHaveLength(3)
    const nodeById = new Map(restored.nodes.map((node) => [node.id, node]))
    expect(nodeById.get(pastedNodeId)).toMatchObject({ type: 'text' })
    expect(nodeById.get(LEGACY_BOX_X_ID)).toMatchObject({ type: 'node_box' })
    expect(restored.edges).toHaveLength(1)
    expect(restored.edges[0]).toMatchObject({
      id: LEGACY_MEMBERSHIP_EDGE_ID,
      sourceNodeId: LEGACY_TEXT_A_ID,
      targetNodeId: LEGACY_BOX_X_ID,
      relationType: 'ordered_box_member',
    })
    await verifyPage.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown())

    const editorAfterVerify = await openCanvasEditor(context, baseURL, LEGACY_CANVAS_ID)
    await expect(editorAfterVerify.getByRole('heading', { name: 'Legacy Membership' })).toBeVisible()
    await editorAfterVerify.screenshot({ path: testInfo.outputPath('10A-06-legacy-membership-paste.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: copying only a Node Box pastes an empty box without any membership', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-box-only-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: BOX_ONLY_CANVAS_ID,
      boxId: BOX_ONLY_BOX_ID,
      memberId: BOX_ONLY_MEMBER_ID,
      edgeId: BOX_ONLY_MEMBERSHIP_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 仅复制节点盒', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.memberId, canvasId: fixture.canvasId, nodeName: '盒外成员', content: { type: 'text', text: '不随盒子复制' }, x: 160, y: 260, createdAtMs: 110 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '原型盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 120 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeId, canvasId: fixture.canvasId, sourceNodeId: fixture.memberId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 130 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, BOX_ONLY_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 仅复制节点盒' })).toBeVisible()
    const originalBox = nodeLocator(editor, BOX_ONLY_BOX_ID)
    const member = nodeLocator(editor, BOX_ONLY_MEMBER_ID)
    await expect(originalBox).toBeVisible()
    await expect(member).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(2)

    // Select ONLY the box; the member stays outside the selection.
    await originalBox.click({ position: { x: 80, y: 18 } })
    await expect(originalBox).toHaveClass(/selected/)
    await expect(member).not.toHaveClass(/selected/)

    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 1 个节点')

    const afterIds = await readNodeIds(editor)
    expect(uniqueIds(afterIds).size).toBe(afterIds.length)
    expect(afterIds).toHaveLength(3)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(1)
    const pastedBoxId = pastedIds[0]!
    const pastedBox = nodeLocator(editor, pastedBoxId)
    await expect(pastedBox).toHaveClass(/selected/)
    await expect(originalBox).not.toHaveClass(/selected/)
    // The pasted box is empty: both member sections show the empty placeholder.
    await expect(pastedBox.getByText('暂无成员')).toHaveCount(2)

    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toEqual([BOX_ONLY_MEMBERSHIP_ID])
    await expectEdgeRendered(editor, BOX_ONLY_MEMBERSHIP_ID)
    await editor.screenshot({ path: testInfo.outputPath('10B-01-box-only.png') })

    const persisted = await readPersistedFixture(context, baseURL, BOX_ONLY_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(3)
    expect(persisted.nodes.find((node) => node.id === pastedBoxId)).toMatchObject({
      type: 'node_box',
      nodeName: '原型盒',
    })
    expect(persisted.edges).toHaveLength(1)
    expect(persisted.edges[0]).toMatchObject({
      id: BOX_ONLY_MEMBERSHIP_ID,
      sourceNodeId: BOX_ONLY_MEMBER_ID,
      targetNodeId: BOX_ONLY_BOX_ID,
      relationType: 'ordered_box_member',
    })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: copies box with selected ordered members and normalizes membership positions', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-ordered-members-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: ORDERED_CANVAS_ID,
      boxId: ORDERED_BOX_ID,
      aId: ORDERED_A_ID,
      bId: ORDERED_B_ID,
      cId: ORDERED_C_ID,
      edgeAId: ORDERED_MEMBERSHIP_A_ID,
      edgeBId: ORDERED_MEMBERSHIP_B_ID,
      edgeCId: ORDERED_MEMBERSHIP_C_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 有序成员复制', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '成员甲', content: { type: 'text', text: 'A 位置0' }, x: 160, y: 260, createdAtMs: 110 })
      await harness.createTextNode({ id: fixture.bId, canvasId: fixture.canvasId, nodeName: '成员乙', content: { type: 'text', text: 'B 位置1' }, x: 430, y: 260, createdAtMs: 120 })
      await harness.createTextNode({ id: fixture.cId, canvasId: fixture.canvasId, nodeName: '成员丙', content: { type: 'text', text: 'C 位置2' }, x: 700, y: 260, createdAtMs: 130 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '有序盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 140 })
      // Insertion order fixes the original positions at 0, 1, 2.
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeAId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 150 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeBId, canvasId: fixture.canvasId, sourceNodeId: fixture.bId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 160 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeCId, canvasId: fixture.canvasId, sourceNodeId: fixture.cId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 170 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, ORDERED_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 有序成员复制' })).toBeVisible()
    const nodeA = nodeLocator(editor, ORDERED_A_ID)
    const nodeB = nodeLocator(editor, ORDERED_B_ID)
    const nodeC = nodeLocator(editor, ORDERED_C_ID)
    const box = nodeLocator(editor, ORDERED_BOX_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()
    await expect(nodeC).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(4)

    // Select box + member A + member C; member B is intentionally excluded.
    await nodeA.click({ position: { x: 80, y: 18 } })
    await box.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await nodeC.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await expect(nodeA).toHaveClass(/selected/)
    await expect(box).toHaveClass(/selected/)
    await expect(nodeC).toHaveClass(/selected/)
    await expect(nodeB).not.toHaveClass(/selected/)

    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 3 个节点')

    const afterIds = await readNodeIds(editor)
    expect(afterIds).toHaveLength(7)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(3)

    const edgeIds = await readEdgeIds(editor)
    expect(uniqueIds(edgeIds).size).toBe(edgeIds.length)
    expect(edgeIds).toHaveLength(5)
    const originalEdgeIds = new Set([
      ORDERED_MEMBERSHIP_A_ID,
      ORDERED_MEMBERSHIP_B_ID,
      ORDERED_MEMBERSHIP_C_ID,
    ])
    const newEdgeIds = edgeIds.filter((id) => !originalEdgeIds.has(id))
    expect(newEdgeIds).toHaveLength(2)
    for (const edgeId of newEdgeIds) {
      await expectEdgeRendered(editor, edgeId)
    }
    await editor.screenshot({ path: testInfo.outputPath('10B-02-ordered-members.png') })

    const persisted = await readPersistedFixture(context, baseURL, ORDERED_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(7)
    const pastedBoxNode = persisted.nodes.find(
      (node) => node.type === 'node_box' && node.id !== ORDERED_BOX_ID,
    )
    expect(pastedBoxNode).toBeDefined()
    const pastedBoxId = pastedBoxNode!.id
    const newMemberships = persisted.edges.filter((edge) => edge.targetNodeId === pastedBoxId)
    expect(newMemberships).toHaveLength(2)
    for (const membership of newMemberships) {
      expect(membership).toMatchObject({
        targetNodeId: pastedBoxId,
        relationType: 'ordered_box_member',
        direction: 'forward',
        lineStyle: 'solid',
      })
      expect(pastedIds).toContain(membership.sourceNodeId)
      expect([ORDERED_A_ID, ORDERED_B_ID, ORDERED_C_ID]).not.toContain(membership.sourceNodeId)
    }
    const normalizedPositions = newMemberships
      .map((membership) => membership.membershipPosition)
      .sort((left, right) => (left ?? 0) - (right ?? 0))
    expect(normalizedPositions).toEqual([0, 1])
    // The skipped member B remains attached to the ORIGINAL box at position 1.
    const membershipB = persisted.edges.find((edge) => edge.id === ORDERED_MEMBERSHIP_B_ID)
    expect(membershipB).toMatchObject({
      sourceNodeId: ORDERED_B_ID,
      targetNodeId: ORDERED_BOX_ID,
      membershipPosition: 1,
    })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: copies box with mixed ordered and unordered members into the right sections', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-mixed-members-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: MIXED_CANVAS_ID,
      boxId: MIXED_BOX_ID,
      aId: MIXED_A_ID,
      cId: MIXED_C_ID,
      edgeAId: MIXED_MEMBERSHIP_A_ID,
      edgeCId: MIXED_MEMBERSHIP_C_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 混合成员复制', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '有序甲', content: { type: 'text', text: '有序成员' }, x: 180, y: 220, createdAtMs: 110 })
      await harness.createTextNode({ id: fixture.cId, canvasId: fixture.canvasId, nodeName: '无序丙', content: { type: 'text', text: '无序成员' }, x: 180, y: 520, createdAtMs: 120 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '混合盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 130 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeAId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 140 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeCId, canvasId: fixture.canvasId, sourceNodeId: fixture.cId, targetNodeId: fixture.boxId, relationType: 'unordered_box_member', createdAtMs: 150 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, MIXED_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 混合成员复制' })).toBeVisible()
    const nodeA = nodeLocator(editor, MIXED_A_ID)
    const nodeC = nodeLocator(editor, MIXED_C_ID)
    const box = nodeLocator(editor, MIXED_BOX_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeC).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(3)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await box.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await nodeC.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 3 个节点')

    const afterIds = await readNodeIds(editor)
    expect(afterIds).toHaveLength(6)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(3)
    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toHaveLength(4)

    // Identify the pasted box in the live DOM (only pasted nodes stay
    // selected, and only Node Boxes carry the BOX header badge) before any
    // harness navigation steals the editor page.
    let pastedBoxId: string | undefined
    for (const id of pastedIds) {
      if (await nodeLocator(editor, id).getByText('BOX', { exact: true }).count() > 0) {
        pastedBoxId = id
        break
      }
    }
    expect(pastedBoxId).toBeDefined()

    // The pasted box renders both rebuilt members under the correct sections.
    const pastedBox = nodeLocator(editor, pastedBoxId!)
    const sections = pastedBox.locator('section')
    await expect(sections.nth(0).getByText('有序甲')).toHaveCount(1)
    await expect(sections.nth(1).getByText('无序丙')).toHaveCount(1)
    await expect(sections.nth(0).getByText('无序丙')).toHaveCount(0)
    await expect(sections.nth(1).getByText('有序甲')).toHaveCount(0)
    await editor.screenshot({ path: testInfo.outputPath('10B-03-mixed-members.png') })

    const persisted = await readPersistedFixture(context, baseURL, MIXED_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(6)
    expect(persisted.nodes.find((node) => node.id === pastedBoxId)).toMatchObject({
      type: 'node_box',
      nodeName: '混合盒',
    })
    const newMemberships = persisted.edges.filter((edge) => edge.targetNodeId === pastedBoxId)
    expect(newMemberships).toHaveLength(2)
    const orderedMembership = newMemberships.find(
      (edge) => edge.relationType === 'ordered_box_member',
    )
    const unorderedMembership = newMemberships.find(
      (edge) => edge.relationType === 'unordered_box_member',
    )
    expect(orderedMembership).toMatchObject({
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: 0,
    })
    expect(unorderedMembership).toMatchObject({
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: 0,
    })
    const pastedAId = orderedMembership!.sourceNodeId
    const pastedCId = unorderedMembership!.sourceNodeId
    expect(pastedIds).toContain(pastedAId)
    expect(pastedIds).toContain(pastedCId)
    expect(pastedAId).not.toBe(pastedCId)
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: copying only a member never rebuilds membership on the pasted node', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-member-only-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: MEMBER_ONLY_CANVAS_ID,
      boxId: MEMBER_ONLY_BOX_ID,
      aId: MEMBER_ONLY_A_ID,
      bId: MEMBER_ONLY_B_ID,
      edgeAId: MEMBER_ONLY_MEMBERSHIP_A_ID,
      edgeBId: MEMBER_ONLY_MEMBERSHIP_B_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 仅复制成员', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '成员A', content: { type: 'text', text: '只复制我' }, x: 180, y: 260, createdAtMs: 110 })
      await harness.createTextNode({ id: fixture.bId, canvasId: fixture.canvasId, nodeName: '成员B', content: { type: 'text', text: '留在原地' }, x: 460, y: 260, createdAtMs: 120 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '不复制的盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 130 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeAId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 140 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeBId, canvasId: fixture.canvasId, sourceNodeId: fixture.bId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 150 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, MEMBER_ONLY_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 仅复制成员' })).toBeVisible()
    const nodeA = nodeLocator(editor, MEMBER_ONLY_A_ID)
    const box = nodeLocator(editor, MEMBER_ONLY_BOX_ID)
    await expect(nodeA).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(3)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await expect(box).not.toHaveClass(/selected/)
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 1 个节点')

    const afterIds = await readNodeIds(editor)
    expect(afterIds).toHaveLength(4)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(1)
    const pastedMemberId = pastedIds[0]!
    await expect(nodeLocator(editor, pastedMemberId)).toHaveClass(/selected/)

    // No new edge of any kind was created.
    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds.sort()).toEqual(
      [MEMBER_ONLY_MEMBERSHIP_A_ID, MEMBER_ONLY_MEMBERSHIP_B_ID].sort(),
    )

    const persisted = await readPersistedFixture(context, baseURL, MEMBER_ONLY_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(4)
    expect(persisted.edges).toHaveLength(2)
    for (const edge of persisted.edges) {
      expect(edge.sourceNodeId).not.toBe(pastedMemberId)
      expect(edge.targetNodeId).not.toBe(pastedMemberId)
      expect(edge.targetNodeId).toBe(MEMBER_ONLY_BOX_ID)
    }
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: ordinary hierarchy edge to a box is copied together with its membership', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-hierarchy-plus-membership-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: HIERARCHY_CANVAS_ID,
      boxId: HIERARCHY_BOX_ID,
      aId: HIERARCHY_A_ID,
      membershipId: HIERARCHY_MEMBERSHIP_ID,
      edgeId: HIERARCHY_EDGE_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 层级边与成员关系', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '层级成员', content: { type: 'text', text: '同时是成员与下级' }, x: 200, y: 280, createdAtMs: 110 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '上级盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 120 })
      await harness.addCanvasNodeBoxMember({ id: fixture.membershipId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 130 })
      // The same endpoint pair also carries an ordinary hierarchy edge.
      await harness.createCanvasEdge({ id: fixture.edgeId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', createdAtMs: 140 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, HIERARCHY_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 层级边与成员关系' })).toBeVisible()
    const nodeA = nodeLocator(editor, HIERARCHY_A_ID)
    const box = nodeLocator(editor, HIERARCHY_BOX_ID)
    await expect(nodeA).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(2)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await box.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')

    const afterIds = await readNodeIds(editor)
    expect(afterIds).toHaveLength(4)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(2)

    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toHaveLength(4)
    const originalEdgeIds = new Set([HIERARCHY_MEMBERSHIP_ID, HIERARCHY_EDGE_ID])
    const newEdgeIds = edgeIds.filter((id) => !originalEdgeIds.has(id))
    expect(newEdgeIds).toHaveLength(2)
    for (const edgeId of newEdgeIds) {
      await expectEdgeRendered(editor, edgeId)
    }

    const persisted = await readPersistedFixture(context, baseURL, HIERARCHY_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(4)
    const pastedBoxId = persisted.nodes.find(
      (node) => node.type === 'node_box' && node.id !== HIERARCHY_BOX_ID,
    )!.id
    const pastedMemberId = persisted.nodes.find(
      (node) => node.type === 'text' && node.id !== HIERARCHY_A_ID,
    )!.id
    const newEdges = persisted.edges.filter(
      (edge) => !originalEdgeIds.has(edge.id),
    )
    expect(newEdges).toHaveLength(2)
    const newMembership = newEdges.find(
      (edge) => edge.relationType === 'ordered_box_member',
    )
    const newHierarchy = newEdges.find(
      (edge) => edge.relationType === 'hierarchy',
    )
    expect(newMembership).toMatchObject({
      sourceNodeId: pastedMemberId,
      targetNodeId: pastedBoxId,
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: 0,
    })
    expect(newHierarchy).toMatchObject({
      sourceNodeId: pastedMemberId,
      targetNodeId: pastedBoxId,
      relationType: 'hierarchy',
      direction: 'forward',
      lineStyle: 'solid',
    })
    expect(newMembership!.id).not.toBe(newHierarchy!.id)
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: copies two boxes with their members and rebuilds each membership independently', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-two-boxes-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: TWO_BOX_CANVAS_ID,
      xId: TWO_BOX_X_ID,
      yId: TWO_BOX_Y_ID,
      aId: TWO_BOX_A_ID,
      bId: TWO_BOX_B_ID,
      edgeAId: TWO_BOX_MEMBERSHIP_A_ID,
      edgeBId: TWO_BOX_MEMBERSHIP_B_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 双节点盒复制', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '属于X', content: { type: 'text', text: 'A' }, x: 180, y: 230, createdAtMs: 110 })
      await harness.createTextNode({ id: fixture.bId, canvasId: fixture.canvasId, nodeName: '属于Y', content: { type: 'text', text: 'B' }, x: 180, y: 640, createdAtMs: 120 })
      await harness.createCanvasNode({ id: fixture.xId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '节点盒X', content: { type: 'node_box' }, x: 1050, y: 160, createdAtMs: 130 })
      await harness.createCanvasNode({ id: fixture.yId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '节点盒Y', content: { type: 'node_box' }, x: 1050, y: 560, createdAtMs: 140 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeAId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.xId, relationType: 'ordered_box_member', createdAtMs: 150 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeBId, canvasId: fixture.canvasId, sourceNodeId: fixture.bId, targetNodeId: fixture.yId, relationType: 'ordered_box_member', createdAtMs: 160 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, TWO_BOX_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 双节点盒复制' })).toBeVisible()
    const nodeA = nodeLocator(editor, TWO_BOX_A_ID)
    const nodeB = nodeLocator(editor, TWO_BOX_B_ID)
    const boxX = nodeLocator(editor, TWO_BOX_X_ID)
    const boxY = nodeLocator(editor, TWO_BOX_Y_ID)
    for (const locator of [nodeA, nodeB, boxX, boxY]) {
      await expect(locator).toBeVisible()
    }

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(4)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await boxX.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await nodeB.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await boxY.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 4 个节点')

    const afterIds = await readNodeIds(editor)
    expect(afterIds).toHaveLength(8)
    const pastedIds = [...uniqueIds(afterIds)].filter((id) => !beforeIds.includes(id))
    expect(pastedIds).toHaveLength(4)
    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toHaveLength(4)
    const originalEdgeIds = new Set([TWO_BOX_MEMBERSHIP_A_ID, TWO_BOX_MEMBERSHIP_B_ID])
    const newEdgeIds = edgeIds.filter((id) => !originalEdgeIds.has(id))
    expect(newEdgeIds).toHaveLength(2)
    for (const edgeId of newEdgeIds) {
      await expectEdgeRendered(editor, edgeId)
    }
    await editor.screenshot({ path: testInfo.outputPath('10B-04-two-boxes.png') })

    const persisted = await readPersistedFixture(context, baseURL, TWO_BOX_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(8)
    const newMemberships = persisted.edges.filter(
      (edge) => !originalEdgeIds.has(edge.id),
    )
    expect(newMemberships).toHaveLength(2)
    for (const membership of newMemberships) {
      expect(membership).toMatchObject({
        relationType: 'ordered_box_member',
        direction: 'forward',
        lineStyle: 'solid',
        membershipPosition: 0,
      })
      expect(pastedIds).toContain(membership.sourceNodeId)
      expect(pastedIds).toContain(membership.targetNodeId)
    }
    const targetToSource = new Map(
      newMemberships.map((edge) => [edge.targetNodeId, edge.sourceNodeId]),
    )
    const pastedNodeNameById = new Map(
      persisted.nodes.map((node) => [node.id, node.nodeName ?? '']),
    )
    const pastedXTarget = newMemberships.find(
      (edge) => pastedNodeNameById.get(edge.targetNodeId) === '节点盒X',
    )
    const pastedYTarget = newMemberships.find(
      (edge) => pastedNodeNameById.get(edge.targetNodeId) === '节点盒Y',
    )
    expect(pastedXTarget).toBeDefined()
    expect(pastedYTarget).toBeDefined()
    expect(pastedNodeNameById.get(targetToSource.get(pastedXTarget!.targetNodeId)!)).toBe('属于X')
    expect(pastedNodeNameById.get(targetToSource.get(pastedYTarget!.targetNodeId)!)).toBe('属于Y')
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: repeated paste of box with member keeps +32 offsets and renormalizes positions each time', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-repeated-paste-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: REPEAT_CANVAS_ID,
      boxId: REPEAT_BOX_ID,
      memberId: REPEAT_MEMBER_ID,
      edgeId: REPEAT_MEMBERSHIP_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 重复粘贴', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.memberId, canvasId: fixture.canvasId, nodeName: '重复成员', content: { type: 'text', text: '成员' }, x: 200, y: 280, createdAtMs: 110 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '重复盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 120 })
      await harness.addCanvasNodeBoxMember({ id: fixture.edgeId, canvasId: fixture.canvasId, sourceNodeId: fixture.memberId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 130 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, REPEAT_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 重复粘贴' })).toBeVisible()
    const member = nodeLocator(editor, REPEAT_MEMBER_ID)
    const box = nodeLocator(editor, REPEAT_BOX_ID)
    await expect(member).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(2)

    await member.click({ position: { x: 80, y: 18 } })
    await box.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')

    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 2 个节点')
    await expect
      .poll(() => readNodeIds(editor), { timeout: 15_000 })
      .toHaveLength(4)

    await ctrlV(editor)
    await expect
      .poll(() => readNodeIds(editor), { timeout: 15_000 })
      .toHaveLength(6)

    const edgeIds = await readEdgeIds(editor)
    expect(edgeIds).toHaveLength(3)
    await editor.screenshot({ path: testInfo.outputPath('10B-05-repeated-paste.png') })

    const persisted = await readPersistedFixture(context, baseURL, REPEAT_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(6)
    const pastedBoxes = persisted.nodes.filter(
      (node) => node.type === 'node_box' && node.id !== REPEAT_BOX_ID,
    )
    const pastedMembers = persisted.nodes.filter(
      (node) => node.type === 'text' && node.id !== REPEAT_MEMBER_ID,
    )
    expect(pastedBoxes).toHaveLength(2)
    expect(pastedMembers).toHaveLength(2)
    // First paste lands at +32, second paste at +64 on both axes.
    expect(pastedBoxes.map((node) => node.x).sort((l, r) => (l ?? 0) - (r ?? 0))).toEqual([1112, 1144])
    expect(pastedMembers.map((node) => node.x).sort((l, r) => (l ?? 0) - (r ?? 0))).toEqual([232, 264])

    const newMemberships = persisted.edges.filter((edge) => edge.id !== REPEAT_MEMBERSHIP_ID)
    expect(newMemberships).toHaveLength(2)
    for (const membership of newMemberships) {
      expect(membership).toMatchObject({
        relationType: 'ordered_box_member',
        direction: 'forward',
        lineStyle: 'solid',
        membershipPosition: 0,
      })
      // Membership always pairs the member and box created by the same paste.
      const memberNode = pastedMembers.find((node) => node.id === membership.sourceNodeId)!
      const boxNode = pastedBoxes.find((node) => node.id === membership.targetNodeId)!
      expect((boxNode.x ?? 0) - (memberNode.x ?? 0)).toBe(880)
      expect((boxNode.y ?? 0) - (memberNode.y ?? 0)).toBe(100)
    }
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('10B: pasted box, members and all edges survive browser restart', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  const baseURL = requireChromiumBaseUrl(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, 'canvas-10b-restart-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await launchProfile(profilePath)
    await seedFixture(context, baseURL, {
      canvasId: RESTART_10B_CANVAS_ID,
      boxId: RESTART_10B_BOX_ID,
      aId: RESTART_10B_A_ID,
      cId: RESTART_10B_C_ID,
      membershipAId: RESTART_10B_MEMBERSHIP_A_ID,
      membershipCId: RESTART_10B_MEMBERSHIP_C_ID,
      hierarchyId: RESTART_10B_HIERARCHY_ID,
    }, async (fixture) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: fixture.canvasId, title: '10B 重启持久化', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: fixture.aId, canvasId: fixture.canvasId, nodeName: '重启有序成员', content: { type: 'text', text: '有序' }, x: 200, y: 230, createdAtMs: 110 })
      await harness.createTextNode({ id: fixture.cId, canvasId: fixture.canvasId, nodeName: '重启无序成员', content: { type: 'text', text: '无序' }, x: 200, y: 520, createdAtMs: 120 })
      await harness.createCanvasNode({ id: fixture.boxId, canvasId: fixture.canvasId, type: 'node_box', nodeName: '重启盒', content: { type: 'node_box' }, x: 1080, y: 380, createdAtMs: 130 })
      await harness.addCanvasNodeBoxMember({ id: fixture.membershipAId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'ordered_box_member', createdAtMs: 140 })
      await harness.addCanvasNodeBoxMember({ id: fixture.membershipCId, canvasId: fixture.canvasId, sourceNodeId: fixture.cId, targetNodeId: fixture.boxId, relationType: 'unordered_box_member', createdAtMs: 150 })
      await harness.createCanvasEdge({ id: fixture.hierarchyId, canvasId: fixture.canvasId, sourceNodeId: fixture.aId, targetNodeId: fixture.boxId, relationType: 'hierarchy', direction: 'forward', lineStyle: 'dashed', createdAtMs: 160 })
      await harness.shutdown()
    })

    const editor = await openCanvasEditor(context, baseURL, RESTART_10B_CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '10B 重启持久化' })).toBeVisible()
    const nodeA = nodeLocator(editor, RESTART_10B_A_ID)
    const nodeC = nodeLocator(editor, RESTART_10B_C_ID)
    const box = nodeLocator(editor, RESTART_10B_BOX_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeC).toBeVisible()
    await expect(box).toBeVisible()

    const beforeIds = await readNodeIds(editor)
    expect(beforeIds).toHaveLength(3)

    await nodeA.click({ position: { x: 80, y: 18 } })
    await box.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await nodeC.click({ modifiers: ['Control'], position: { x: 80, y: 18 } })
    await ctrlC(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已复制节点')
    await ctrlV(editor)
    await expect(editor.locator('[role="status"]')).toHaveText('已粘贴 3 个节点')

    await expect
      .poll(() => readNodeIds(editor), { timeout: 15_000 })
      .toHaveLength(6)
    await expect
      .poll(() => readEdgeIds(editor), { timeout: 15_000 })
      .toHaveLength(6)

    // Full restart: close the browser context and reopen the SAME profile.
    await context.close()
    context = await launchProfile(profilePath)

    let persisted = await readPersistedFixture(context, baseURL, RESTART_10B_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(6)
    expect(persisted.edges).toHaveLength(6)
    const pastedBoxId = persisted.nodes.find(
      (node) => node.type === 'node_box' && node.id !== RESTART_10B_BOX_ID,
    )!.id
    const pastedAId = persisted.nodes.find(
      (node) => node.nodeName === '重启有序成员' && node.id !== RESTART_10B_A_ID,
    )!.id
    const pastedCId = persisted.nodes.find(
      (node) => node.nodeName === '重启无序成员' && node.id !== RESTART_10B_C_ID,
    )!.id
    const newEdges = persisted.edges.filter(
      (edge) =>
        ![
          RESTART_10B_MEMBERSHIP_A_ID,
          RESTART_10B_MEMBERSHIP_C_ID,
          RESTART_10B_HIERARCHY_ID,
        ].includes(edge.id),
    )
    expect(newEdges).toHaveLength(3)
    expect(newEdges.find((edge) => edge.relationType === 'ordered_box_member')).toMatchObject({
      sourceNodeId: pastedAId,
      targetNodeId: pastedBoxId,
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: 0,
    })
    expect(newEdges.find((edge) => edge.relationType === 'unordered_box_member')).toMatchObject({
      sourceNodeId: pastedCId,
      targetNodeId: pastedBoxId,
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: 0,
    })
    expect(newEdges.find((edge) => edge.relationType === 'hierarchy')).toMatchObject({
      sourceNodeId: pastedAId,
      targetNodeId: pastedBoxId,
      direction: 'forward',
      lineStyle: 'dashed',
    })

    // Release OPFS before opening the editor again in the same profile.
    const harnessPage = await openHarnessPage(context, baseURL)
    await harnessPage.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown())

    const editorAfterRestart = await openCanvasEditor(context, baseURL, RESTART_10B_CANVAS_ID)
    await expect(editorAfterRestart.getByRole('heading', { name: '10B 重启持久化' })).toBeVisible()
    await expect
      .poll(() => readNodeIds(editorAfterRestart), { timeout: 15_000 })
      .toHaveLength(6)
    const restoredEdgeIds = await readEdgeIds(editorAfterRestart)
    expect(restoredEdgeIds).toHaveLength(6)
    for (const edge of newEdges) {
      await expectEdgeRendered(editorAfterRestart, edge.id)
    }
    const restoredPastedBox = nodeLocator(editorAfterRestart, pastedBoxId)
    await expect(restoredPastedBox).toBeVisible()
    const sections = restoredPastedBox.locator('section')
    await expect(sections.nth(0).getByText('重启有序成员')).toHaveCount(1)
    await expect(sections.nth(1).getByText('重启无序成员')).toHaveCount(1)
    await editorAfterRestart.screenshot({ path: testInfo.outputPath('10B-06-restart.png') })

    persisted = await readPersistedFixture(context, baseURL, RESTART_10B_CANVAS_ID)
    expect(persisted.nodes).toHaveLength(6)
    expect(persisted.edges).toHaveLength(6)
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})
