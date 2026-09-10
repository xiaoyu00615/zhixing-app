import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'

interface CanvasRecordLike {
  readonly id: string
  readonly nodeName?: string
  readonly type?: string
}

interface EdgeRecordLike {
  readonly id: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType?: string
  readonly direction?: string
  readonly lineStyle?: string
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
