import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'

interface CanvasHarness {
  auditMigrationTenRollback(): Promise<{
    readonly failedClosed: boolean
    readonly historyVersion: number
    readonly originalNodeCount: number
    readonly originalTablesPresent: boolean
    readonly temporaryTablesPresent: boolean
  }>
  auditMigrationTenUpgrade(): Promise<{
    readonly historyVersion: number
    readonly canvasPreserved: boolean
    readonly nodesPreserved: number
    readonly edgesPreserved: number
    readonly unknownEdgePreserved: boolean
    readonly ordinaryMembershipPositionsNull: number
    readonly membershipColumnPresent: boolean
    readonly nodeSoftDeleteColumnPresent: boolean
    readonly temporaryTablesPresent: boolean
    readonly foreignKeyViolations: number
  }>
  capability(): Promise<{ status: string; reason?: string }>
  createCanvas(input: object): Promise<unknown>
  listCanvases(): Promise<readonly Record<string, unknown>[]>
  getCanvas(id: string): Promise<Record<string, unknown>>
  renameCanvas(input: object): Promise<unknown>
  updateCanvasViewport(input: object): Promise<unknown>
  createTextNode(input: object): Promise<unknown>
  createCanvasNode(input: object): Promise<unknown>
  listCanvasNodes(canvasId: string): Promise<readonly Record<string, unknown>[]>
  updateTextNode(input: object): Promise<unknown>
  updateCanvasNodeContent(input: object): Promise<unknown>
  renameCanvasNode(input: object): Promise<unknown>
  deleteCanvasNode(input: object): Promise<void>
  moveCanvasNode(input: object): Promise<unknown>
  moveCanvasNodes(input: object): Promise<readonly Record<string, unknown>[]>
  createCanvasEdge(input: object): Promise<Record<string, unknown>>
  addCanvasNodeBoxMember(input: object): Promise<Record<string, unknown>>
  reorderCanvasNodeBoxMemberships(input: object): Promise<readonly Record<string, unknown>[]>
  listCanvasEdges(canvasId: string): Promise<readonly Record<string, unknown>[]>
  updateCanvasEdgeRelationType(input: object): Promise<Record<string, unknown>>
  updateCanvasEdgeDirection(input: object): Promise<Record<string, unknown>>
  updateCanvasEdgeLineStyle(input: object): Promise<Record<string, unknown>>
  deleteCanvasEdge(input: object): Promise<Record<string, unknown>>
  shutdown(): Promise<void>
}

type HarnessWindow = Window & { __taskPersistenceHarness: CanvasHarness }
const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const NODE_ID = '00000000-0000-4000-8000-000000000602'
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000603'
const EDGE_ID = '00000000-0000-4000-8000-000000000604'
const OTHER_CANVAS_ID = '00000000-0000-4000-8000-000000000612'
const OTHER_NODE_ID = '00000000-0000-4000-8000-000000000613'
const UI_CANVAS_ID = '00000000-0000-4000-8000-000000000701'
const UI_NODE_A_ID = '00000000-0000-4000-8000-000000000702'
const UI_NODE_B_ID = '00000000-0000-4000-8000-000000000703'
const UI_NODE_C_ID = '00000000-0000-4000-8000-000000000704'
const UI_EDGE_ID = '00000000-0000-4000-8000-000000000705'
const NAME_CANVAS_ID = '00000000-0000-4000-8000-000000000801'
const NAME_TEXT_ID = '00000000-0000-4000-8000-000000000802'
const NAME_STICKY_ID = '00000000-0000-4000-8000-000000000803'
const SEMANTIC_CANVAS_ID = '00000000-0000-4000-8000-000000000901'
const SEMANTIC_TEXT_ID = '00000000-0000-4000-8000-000000000902'
const SEMANTIC_STICKY_ID = '00000000-0000-4000-8000-000000000903'
const SEMANTIC_EDGE_ID = '00000000-0000-4000-8000-000000000904'
const SEMANTIC_SECOND_STICKY_ID = '00000000-0000-4000-8000-000000000905'
const SEMANTIC_REVERSE_EDGE_ID = '00000000-0000-4000-8000-000000000906'
const SEMANTIC_STICKY_EDGE_ID = '00000000-0000-4000-8000-000000000907'
const SEMANTIC_CONFLICT_EDGE_ID = '00000000-0000-4000-8000-000000000908'
const BOX_CANVAS_ID = '00000000-0000-4000-8000-000000001001'
const BOX_TEXT_ID = '00000000-0000-4000-8000-000000001002'
const BOX_STICKY_ID = '00000000-0000-4000-8000-000000001003'
const BOX_EXTRA_ID = '00000000-0000-4000-8000-000000001004'
const BOX_NODE_ID = '00000000-0000-4000-8000-000000001005'
const BOX_ORDERED_EDGE_ID = '00000000-0000-4000-8000-000000001006'
const BOX_UNORDERED_EDGE_ID = '00000000-0000-4000-8000-000000001007'
const BOX_EMPTY_ID = '00000000-0000-4000-8000-000000001008'
const BOX_ORDINARY_EDGE_ID = '00000000-0000-4000-8000-000000001009'
const REORDER_CANVAS_ID = '00000000-0000-4000-8000-000000001101'
const REORDER_NODE_IDS = [
  '00000000-0000-4000-8000-000000001102',
  '00000000-0000-4000-8000-000000001103',
  '00000000-0000-4000-8000-000000001104',
  '00000000-0000-4000-8000-000000001105',
  '00000000-0000-4000-8000-000000001108',
  '00000000-0000-4000-8000-000000001109',
] as const
const REORDER_BOX_IDS = [
  '00000000-0000-4000-8000-000000001106',
  '00000000-0000-4000-8000-000000001107',
] as const
const REORDER_EDGE_IDS = [
  '00000000-0000-4000-8000-000000001110',
  '00000000-0000-4000-8000-000000001111',
  '00000000-0000-4000-8000-000000001112',
  '00000000-0000-4000-8000-000000001113',
  '00000000-0000-4000-8000-000000001114',
  '00000000-0000-4000-8000-000000001115',
] as const
const REORDER_ORDINARY_EDGE_ID = '00000000-0000-4000-8000-000000001116'
const CONTEXT_CANVAS_ID = '00000000-0000-4000-8000-000000001201'
const CONTEXT_NODE_IDS = [
  '00000000-0000-4000-8000-000000001202',
  '00000000-0000-4000-8000-000000001203',
  '00000000-0000-4000-8000-000000001204',
] as const
const CONTEXT_BOX_ID = '00000000-0000-4000-8000-000000001205'
const CONTEXT_EDGE_ID = '00000000-0000-4000-8000-000000001206'
const CONTEXT_ORDERED_EDGE_ID = '00000000-0000-4000-8000-000000001207'
const CONTEXT_UNORDERED_EDGE_ID = '00000000-0000-4000-8000-000000001208'
const NODE_MENU_CANVAS_ID = '00000000-0000-4000-8000-000000001301'
const NODE_MENU_TEXT_ID = '00000000-0000-4000-8000-000000001302'
const NODE_MENU_STICKY_ID = '00000000-0000-4000-8000-000000001303'
const NODE_MENU_BOX_ID = '00000000-0000-4000-8000-000000001304'
const NODE_MENU_EDGE_ID = '00000000-0000-4000-8000-000000001305'
const NODE_MENU_ORDERED_ID = '00000000-0000-4000-8000-000000001306'
const NODE_MENU_UNORDERED_ID = '00000000-0000-4000-8000-000000001307'

async function openHarnessPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/tests/e2e/persistence.html`)
  await page.waitForFunction(() => '__taskPersistenceHarness' in window)
  return page
}

test('rolls a failed Web Migration 10 table rebuild back atomically', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${baseURL}/tests/e2e/persistence.html`)
    await page.waitForFunction(() => '__taskPersistenceHarness' in window)
    await expect(page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.auditMigrationTenRollback(),
    )).resolves.toEqual({
      failedClosed: true,
      historyVersion: 9,
      originalNodeCount: 1,
      originalTablesPresent: true,
      temporaryTablesPresent: false,
    })
  } finally {
    await browser.close()
  }
})

test('preserves exact v9 Canvas data through Web Migrations 10 and 11', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${baseURL}/tests/e2e/persistence.html`)
    await page.waitForFunction(() => '__taskPersistenceHarness' in window)
    await expect(page.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.auditMigrationTenUpgrade(),
    )).resolves.toEqual({
      historyVersion: 11,
      canvasPreserved: true,
      nodesPreserved: 2,
      edgesPreserved: 4,
      unknownEdgePreserved: true,
      ordinaryMembershipPositionsNull: 4,
      membershipColumnPresent: true,
      nodeSoftDeleteColumnPresent: true,
      temporaryTablesPresent: false,
      foreignKeyViolations: 0,
    })
  } finally {
    await browser.close()
  }
})

test('persists Canvas nodes, viewport, and configured Edge in OPFS across restart', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true })
    let page = await openHarnessPage(context, baseURL)
    const capability = await page.evaluate(() => (window as unknown as HarnessWindow).__taskPersistenceHarness.capability())
    expect(capability).toEqual({ status: 'AVAILABLE' })
    await page.evaluate(async ({ canvasId, nodeId, targetNodeId, edgeId, otherCanvasId, otherNodeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const expectFailure = async (operation: Promise<unknown>, expected: string) => {
        try {
          await operation
        } catch (error: unknown) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === expected) return
          throw error
        }
        throw new Error(`Expected ${expected}.`)
      }
      await harness.createCanvas({ id: canvasId, title: 'Canvas Restart', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await harness.createTextNode({ id: nodeId, canvasId, content: { type: 'text', text: 'first' }, x: 40, y: 80, createdAtMs: 20 })
      await harness.createCanvasNode({ id: targetNodeId, canvasId, type: 'sticky', content: { type: 'sticky', text: 'second' }, x: 460, y: 180, createdAtMs: 21 })
      const created = await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: nodeId, targetNodeId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 25 })
      if (created.direction !== 'forward' || created.lineStyle !== 'solid') throw new Error('Default Edge mismatch.')
      await expectFailure(harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000605', canvasId, sourceNodeId: nodeId, targetNodeId, relationType: 'default', direction: 'forward', lineStyle: 'dotted', createdAtMs: 26 }), 'DUPLICATE')
      await harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000606', canvasId, sourceNodeId: targetNodeId, targetNodeId: nodeId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 27 })
      await harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000607', canvasId, sourceNodeId: nodeId, targetNodeId, relationType: 'default', direction: 'none', lineStyle: 'solid', createdAtMs: 28 })
      await expectFailure(harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000608', canvasId, sourceNodeId: targetNodeId, targetNodeId: nodeId, relationType: 'default', direction: 'none', lineStyle: 'solid', createdAtMs: 29 }), 'DUPLICATE')
      await harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000609', canvasId, sourceNodeId: nodeId, targetNodeId, relationType: 'default', direction: 'bidirectional', lineStyle: 'solid', createdAtMs: 30 })
      await expectFailure(harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000610', canvasId, sourceNodeId: targetNodeId, targetNodeId: nodeId, relationType: 'default', direction: 'bidirectional', lineStyle: 'solid', createdAtMs: 31 }), 'DUPLICATE')
      await expectFailure(harness.updateCanvasEdgeDirection({ id: edgeId, direction: 'none', updatedAtMs: 32 }), 'DUPLICATE')
      await expectFailure(harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000611', canvasId, sourceNodeId: nodeId, targetNodeId: nodeId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 33 }), 'PERSISTENCE_FAILED')
      await harness.createCanvas({ id: otherCanvasId, title: 'Other Canvas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await harness.createTextNode({ id: otherNodeId, canvasId: otherCanvasId, content: { type: 'text', text: 'other' }, x: 0, y: 0, createdAtMs: 20 })
      await expectFailure(harness.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000614', canvasId, sourceNodeId: nodeId, targetNodeId: otherNodeId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 33 }), 'NOT_FOUND')
      await harness.deleteCanvasEdge({ id: '00000000-0000-4000-8000-000000000606', deletedAtMs: 34, updatedAtMs: 34 })
      await harness.deleteCanvasEdge({ id: '00000000-0000-4000-8000-000000000607', deletedAtMs: 34, updatedAtMs: 34 })
      await harness.deleteCanvasEdge({ id: '00000000-0000-4000-8000-000000000609', deletedAtMs: 34, updatedAtMs: 34 })
      await harness.updateCanvasEdgeDirection({ id: edgeId, direction: 'bidirectional', updatedAtMs: 35 })
      await harness.updateCanvasEdgeLineStyle({ id: edgeId, lineStyle: 'dashed', updatedAtMs: 36 })
      await harness.updateTextNode({ id: nodeId, content: { type: 'text', text: 'persisted text' }, updatedAtMs: 30 })
      await harness.updateCanvasNodeContent({ id: targetNodeId, type: 'sticky', content: { type: 'sticky', text: 'persisted sticky' }, updatedAtMs: 31 })
      await harness.renameCanvasNode({ canvasId, id: nodeId, nodeName: '产品构思', updatedAtMs: 32 })
      await harness.renameCanvasNode({ canvasId, id: targetNodeId, nodeName: '灵感记录', updatedAtMs: 33 })
      await harness.moveCanvasNodes({ canvasId, moves: [
        { nodeId, x: 240, y: -60 },
        { nodeId: targetNodeId, x: 560, y: 240 },
      ], updatedAtMs: 40 })
      await expectFailure(harness.moveCanvasNodes({ canvasId, moves: [
        { nodeId, x: 999, y: 999 },
        { nodeId: otherNodeId, x: 888, y: 888 },
      ], updatedAtMs: 41 }), 'NOT_FOUND')
      await expectFailure(harness.moveCanvasNodes({ canvasId, moves: [
        { nodeId, x: 777, y: 777 },
        { nodeId: '00000000-0000-4000-8000-000000000699', x: 666, y: 666 },
      ], updatedAtMs: 42 }), 'NOT_FOUND')
      await harness.updateCanvasViewport({ id: canvasId, viewport: { x: 120, y: 48, zoom: 1.35 }, updatedAtMs: 50 })
      await harness.renameCanvas({ id: canvasId, title: 'Canvas Restored', updatedAtMs: 60 })
      await harness.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_ID, targetNodeId: TARGET_NODE_ID, edgeId: EDGE_ID, otherCanvasId: OTHER_CANVAS_ID, otherNodeId: OTHER_NODE_ID })
    await context.close()
    context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true })
    page = await openHarnessPage(context, baseURL)
    const restored = await page.evaluate(async ({ canvasId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return { canvases: await harness.listCanvases(), canvas: await harness.getCanvas(canvasId), nodes: await harness.listCanvasNodes(canvasId), edges: await harness.listCanvasEdges(canvasId) }
    }, { canvasId: CANVAS_ID })
    expect(restored.canvases).toEqual(expect.arrayContaining([expect.objectContaining({ id: CANVAS_ID }), expect.objectContaining({ id: OTHER_CANVAS_ID })]))
    expect(restored.canvas).toMatchObject({ title: 'Canvas Restored', viewport: { x: 120, y: 48, zoom: 1.35 } })
    expect(restored.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: NODE_ID, nodeName: '产品构思', content: { type: 'text', text: 'persisted text' }, x: 240, y: -60, updatedAtMs: 40 }),
      expect.objectContaining({ id: TARGET_NODE_ID, type: 'sticky', nodeName: '灵感记录', content: { type: 'sticky', text: 'persisted sticky' }, x: 560, y: 240, updatedAtMs: 40 }),
    ]))
    expect(restored.edges).toEqual([expect.objectContaining({ id: EDGE_ID, canvasId: CANVAS_ID, sourceNodeId: NODE_ID, targetNodeId: TARGET_NODE_ID, relationType: 'default', direction: 'bidirectional', lineStyle: 'dashed', deletedAtMs: null })])

    await page.evaluate(async ({ canvasId, edgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.deleteCanvasEdge({ id: edgeId, deletedAtMs: 70, updatedAtMs: 70 })
      if ((await harness.listCanvasEdges(canvasId)).length !== 0) throw new Error('Deleted Edge remained active.')
      await harness.shutdown()
    }, { canvasId: CANVAS_ID, edgeId: EDGE_ID })
    await context.close()
    context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true })
    page = await openHarnessPage(context, baseURL)
    await expect(page.evaluate((canvasId) => (window as unknown as HarnessWindow).__taskPersistenceHarness.listCanvasEdges(canvasId), CANVAS_ID)).resolves.toEqual([])
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('selects, collectively moves, and pans the real Canvas editor', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-selection-browser-profile')
  const outputRoot = resolve(testInfo.outputDir)
  const resolvedProfile = resolve(profilePath)
  if (!resolvedProfile.startsWith(`${outputRoot}${sep}`)) throw new Error('Unsafe test profile path.')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 900 },
    })
    const page = await openHarnessPage(context, baseURL)
    await page.evaluate(async ({ canvasId, nodeAId, nodeBId, nodeCId, edgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Selection Slice 3', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: nodeAId, canvasId, content: { type: 'text', text: 'Node A' }, x: 220, y: 150, createdAtMs: 110 })
      await harness.createTextNode({ id: nodeBId, canvasId, content: { type: 'text', text: 'Node B' }, x: 600, y: 190, createdAtMs: 120 })
      await harness.createTextNode({ id: nodeCId, canvasId, content: { type: 'text', text: 'Node C' }, x: 460, y: 480, createdAtMs: 130 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: nodeAId, targetNodeId: nodeBId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 140 })
      await harness.shutdown()
    }, {
      canvasId: UI_CANVAS_ID,
      nodeAId: UI_NODE_A_ID,
      nodeBId: UI_NODE_B_ID,
      nodeCId: UI_NODE_C_ID,
      edgeId: UI_EDGE_ID,
    })

    await page.goto(`${baseURL}/canvas/${UI_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Selection Slice 3' })).toBeVisible()
    const nodeA = page.locator(`.react-flow__node[data-id="${UI_NODE_A_ID}"]`)
    const nodeB = page.locator(`.react-flow__node[data-id="${UI_NODE_B_ID}"]`)
    const nodeC = page.locator(`.react-flow__node[data-id="${UI_NODE_C_ID}"]`)
    const viewport = page.locator('.react-flow__viewport')
    const edgePath = page.locator(`.react-flow__edge[data-id="${UI_EDGE_ID}"] path`).first()

    await nodeA.click({ position: { x: 110, y: 146 } })
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).not.toHaveClass(/selected/)
    await page.screenshot({ path: testInfo.outputPath('01-single-selection.png') })

    await nodeB.click({ modifiers: ['Control'], position: { x: 110, y: 146 } })
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)
    await expect(nodeC).not.toHaveClass(/selected/)

    const boxA = await nodeA.boundingBox()
    const boxB = await nodeB.boundingBox()
    if (boxA === null || boxB === null) throw new Error('Selection nodes are not visible.')
    const viewportBeforeSelection = await viewport.getAttribute('style')
    const selectionStart = {
      x: Math.min(boxA.x, boxB.x) - 20,
      y: Math.min(boxA.y, boxB.y) - 20,
    }
    const selectionEnd = {
      x: Math.max(boxA.x + boxA.width, boxB.x + boxB.width) + 20,
      y: Math.max(boxA.y + boxA.height, boxB.y + boxB.height) + 20,
    }
    await page.mouse.move(selectionStart.x, selectionStart.y)
    await page.mouse.down()
    await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 12 })
    await expect(page.locator('.react-flow__selection')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('02-box-selection.png') })
    await page.mouse.up()
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)
    await expect(nodeC).not.toHaveClass(/selected/)
    expect(await viewport.getAttribute('style')).toBe(viewportBeforeSelection)

    const nodeABefore = await nodeA.boundingBox()
    const nodeBBefore = await nodeB.boundingBox()
    const nodeCBefore = await nodeC.boundingBox()
    const edgeBefore = await edgePath.getAttribute('d')
    if (nodeABefore === null || nodeBBefore === null || nodeCBefore === null) {
      throw new Error('Collective move nodes are not visible.')
    }
    await page.mouse.move(nodeABefore.x + 110, nodeABefore.y + 146)
    await page.mouse.down()
    await page.mouse.move(nodeABefore.x + 230, nodeABefore.y + 226, { steps: 12 })
    await page.mouse.up()
    await expect(page.getByRole('status')).toContainText('已移动 2 个节点')
    const nodeAAfter = await nodeA.boundingBox()
    const nodeBAfter = await nodeB.boundingBox()
    const nodeCAfter = await nodeC.boundingBox()
    if (nodeAAfter === null || nodeBAfter === null || nodeCAfter === null) {
      throw new Error('Moved nodes are not visible.')
    }
    const movedX = nodeAAfter.x - nodeABefore.x
    const movedY = nodeAAfter.y - nodeABefore.y
    expect(movedX).toBeGreaterThan(80)
    expect(movedY).toBeGreaterThan(50)
    expect(nodeBAfter.x - nodeBBefore.x).toBeCloseTo(movedX, 0)
    expect(nodeBAfter.y - nodeBBefore.y).toBeCloseTo(movedY, 0)
    expect(nodeCAfter.x).toBeCloseTo(nodeCBefore.x, 0)
    expect(nodeCAfter.y).toBeCloseTo(nodeCBefore.y, 0)
    expect(await edgePath.getAttribute('d')).not.toBe(edgeBefore)
    await page.screenshot({ path: testInfo.outputPath('03-collective-move-edge-follow.png') })

    const viewportBeforeRightDrag = await viewport.getAttribute('style')
    await page.mouse.move(nodeCAfter.x + 80, nodeCAfter.y + 60)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(nodeCAfter.x + 150, nodeCAfter.y + 110, { steps: 6 })
    await page.mouse.up({ button: 'right' })
    await page.keyboard.press('Escape')
    expect(await viewport.getAttribute('style')).toBe(viewportBeforeRightDrag)

    const viewportBeforeMiddlePan = await viewport.getAttribute('style')
    await page.mouse.move(nodeCAfter.x + 100, nodeCAfter.y + 70)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(nodeCAfter.x + 180, nodeCAfter.y + 120, { steps: 8 })
    await page.mouse.up({ button: 'middle' })
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(viewportBeforeMiddlePan)

    const viewportBeforeTyping = await viewport.getAttribute('style')
    const editorA = nodeA.getByRole('textbox', { name: '文字节点内容' })
    await editorA.fill('')
    await page.keyboard.type('WASD test')
    await editorA.press('Tab')
    await expect(editorA).toHaveValue('WASD test')
    expect(await viewport.getAttribute('style')).toBe(viewportBeforeTyping)

    await page.locator('.react-flow__pane').click({ position: { x: 40, y: 80 } })
    const verifyImmediateKeyboardPan = async (key: 'w' | 'a' | 's' | 'd') => {
      const before = await viewport.getAttribute('style')
      await viewport.evaluate((element, previousStyle) => {
        const target = element as HTMLElement
        target.dataset.wasdLatency = ''
        const startedAt = performance.now()
        const observer = new MutationObserver(() => {
          if (target.getAttribute('style') === previousStyle) return
          target.dataset.wasdLatency = String(performance.now() - startedAt)
          observer.disconnect()
        })
        observer.observe(target, { attributes: true, attributeFilter: ['style'] })
      }, before)
      await page.keyboard.down(key)
      await expect.poll(
        () => viewport.getAttribute('data-wasd-latency'),
        { intervals: [10, 10, 20], timeout: 250 },
      ).not.toBe('')
      await page.keyboard.up(key)
      const latency = Number(await viewport.getAttribute('data-wasd-latency'))
      expect(latency).toBeLessThan(150)
    }
    for (const key of ['w', 'a', 's', 'd'] as const) {
      await verifyImmediateKeyboardPan(key)
    }

    const readViewportPosition = () => viewport.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
      return { x: matrix.m41, y: matrix.m42 }
    })
    const verifyReleaseFirstReversal = async (
      first: 'w' | 'a' | 's' | 'd',
      opposite: 'w' | 'a' | 's' | 'd',
      axis: 'x' | 'y',
      oppositeSign: -1 | 1,
    ) => {
      await page.keyboard.down(first)
      await page.waitForTimeout(220)
      await page.keyboard.up(first)
      await page.waitForTimeout(4)
      const before = await readViewportPosition()
      await viewport.evaluate((element) => {
        const probeWindow = window as typeof window & {
          __wasdFrameProbe?: {
            readonly startedAt: number
            readonly times: number[]
            readonly observer: MutationObserver
          }
        }
        probeWindow.__wasdFrameProbe?.observer.disconnect()
        const times: number[] = []
        const observer = new MutationObserver(() => { times.push(performance.now()) })
        observer.observe(element, { attributes: true, attributeFilter: ['style'] })
        probeWindow.__wasdFrameProbe = { startedAt: performance.now(), times, observer }
      })
      await page.keyboard.down(opposite)
      await page.waitForTimeout(450)
      const after = await readViewportPosition()
      const frameProbe = await page.evaluate(() => {
        const probeWindow = window as typeof window & {
          __wasdFrameProbe?: {
            readonly startedAt: number
            readonly times: number[]
            readonly observer: MutationObserver
          }
        }
        const probe = probeWindow.__wasdFrameProbe
        if (probe === undefined) throw new Error('WASD frame probe is missing')
        probe.observer.disconnect()
        delete probeWindow.__wasdFrameProbe
        return { startedAt: probe.startedAt, endedAt: performance.now(), times: probe.times }
      })
      expect(Math.sign(after[axis] - before[axis])).toBe(oppositeSign)
      expect(frameProbe.times.length).toBeGreaterThan(3)
      const frameIntervals = frameProbe.times.map((time, index) =>
        time - (frameProbe.times[index - 1] ?? frameProbe.startedAt))
      frameIntervals.push(frameProbe.endedAt - frameProbe.times.at(-1)!)
      expect(Math.max(...frameIntervals)).toBeLessThan(150)
      await page.keyboard.up(opposite)
      await page.waitForTimeout(500)
    }
    await verifyReleaseFirstReversal('d', 'a', 'x', 1)
    await verifyReleaseFirstReversal('a', 'd', 'x', -1)
    await verifyReleaseFirstReversal('w', 's', 'y', -1)
    await verifyReleaseFirstReversal('s', 'w', 'y', 1)

    const verifyReversal = async (
      first: 'w' | 'a' | 's' | 'd',
      opposite: 'w' | 'a' | 's' | 'd',
      axis: 'x' | 'y',
      oppositeSign: -1 | 1,
    ) => {
      await page.keyboard.down(first)
      await page.waitForTimeout(180)
      const before = await readViewportPosition()
      await page.keyboard.down(opposite)
      await page.waitForTimeout(60)
      const after = await readViewportPosition()
      expect(Math.sign(after[axis] - before[axis])).toBe(oppositeSign)
      await page.keyboard.up(opposite)
      await page.keyboard.up(first)
      await page.waitForTimeout(500)
    }
    await verifyReversal('d', 'a', 'x', 1)
    await verifyReversal('a', 'd', 'x', -1)
    await verifyReversal('w', 's', 'y', -1)
    await verifyReversal('s', 'w', 'y', 1)

    await page.keyboard.down('d')
    await page.waitForTimeout(120)
    await page.keyboard.down('a')
    await page.waitForTimeout(60)
    const beforeHorizontalFallback = await readViewportPosition()
    await page.keyboard.up('a')
    await page.waitForTimeout(60)
    const afterHorizontalFallback = await readViewportPosition()
    expect(afterHorizontalFallback.x).toBeLessThan(beforeHorizontalFallback.x)
    await page.keyboard.up('d')
    await page.waitForTimeout(500)

    await page.keyboard.down('w')
    await page.keyboard.down('d')
    await page.waitForTimeout(120)
    const beforeDiagonalHorizontalReversal = await readViewportPosition()
    await page.keyboard.down('a')
    await page.waitForTimeout(60)
    const afterDiagonalHorizontalReversal = await readViewportPosition()
    expect(afterDiagonalHorizontalReversal.x).toBeGreaterThan(beforeDiagonalHorizontalReversal.x)
    expect(afterDiagonalHorizontalReversal.y).toBeGreaterThan(beforeDiagonalHorizontalReversal.y)
    await page.keyboard.up('a')
    await page.keyboard.down('s')
    await page.waitForTimeout(60)
    const afterDiagonalVerticalReversal = await readViewportPosition()
    expect(afterDiagonalVerticalReversal.x).toBeLessThan(afterDiagonalHorizontalReversal.x)
    expect(afterDiagonalVerticalReversal.y).toBeLessThan(afterDiagonalHorizontalReversal.y)
    await page.keyboard.up('s')
    await page.keyboard.up('d')
    await page.keyboard.up('w')
    await page.waitForTimeout(500)

    const alternateDirections = async (
      first: 'w' | 'a',
      second: 's' | 'd',
      axis: 'x' | 'y',
      firstSign: -1 | 1,
      secondSign: -1 | 1,
    ) => {
      let held: 'w' | 'a' | 's' | 'd' = first
      await page.keyboard.down(held)
      for (let index = 0; index < 20; index += 1) {
        const next: 'w' | 'a' | 's' | 'd' = held === first ? second : first
        const before = await readViewportPosition()
        await page.keyboard.down(next)
        await page.waitForTimeout(250)
        const after = await readViewportPosition()
        expect(Math.sign(after[axis] - before[axis])).toBe(next === first ? firstSign : secondSign)
        await page.keyboard.up(held)
        held = next
      }
      await page.keyboard.up(held)
      await page.waitForTimeout(500)
    }
    await alternateDirections('a', 'd', 'x', 1, -1)
    await alternateDirections('w', 's', 'y', 1, -1)

    const viewportBeforeQuickTap = await viewport.getAttribute('style')
    await page.keyboard.down('w')
    await page.waitForTimeout(35)
    await page.keyboard.up('w')
    expect(await viewport.getAttribute('style')).not.toBe(viewportBeforeQuickTap)

    const viewportBeforeWasd = await viewport.getAttribute('style')
    await page.keyboard.down('w')
    await page.keyboard.down('d')
    await page.waitForTimeout(180)
    await page.keyboard.up('d')
    await page.keyboard.up('w')
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(viewportBeforeWasd)

    const viewportBeforeLongHold = await viewport.getAttribute('style')
    await page.keyboard.down('w')
    await page.waitForTimeout(3000)
    await page.keyboard.up('w')
    const viewportAfterLongHold = await viewport.getAttribute('style')
    expect(viewportAfterLongHold).not.toBe(viewportBeforeLongHold)
    await page.waitForTimeout(100)
    expect(await viewport.getAttribute('style')).toBe(viewportAfterLongHold)
    await page.waitForTimeout(500)
    await page.screenshot({ path: testInfo.outputPath('04-middle-wasd-pan.png') })

    const viewportBeforeZoom = await viewport.getAttribute('style')
    const pane = page.locator('.react-flow__pane')
    const paneBox = await pane.boundingBox()
    if (paneBox === null) throw new Error('Canvas pane is not visible.')
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
    await page.mouse.wheel(0, -320)
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(viewportBeforeZoom)

    const persistedA = await nodeA.evaluate((element) => (element as HTMLElement).style.transform)
    const persistedB = await nodeB.evaluate((element) => (element as HTMLElement).style.transform)
    const persistedC = await nodeC.evaluate((element) => (element as HTMLElement).style.transform)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Selection Slice 3' })).toBeVisible()
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${UI_NODE_A_ID}"]`).evaluate((element) => (element as HTMLElement).style.transform)).toBe(persistedA)
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${UI_NODE_B_ID}"]`).evaluate((element) => (element as HTMLElement).style.transform)).toBe(persistedB)
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${UI_NODE_C_ID}"]`).evaluate((element) => (element as HTMLElement).style.transform)).toBe(persistedC)
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('05-restart-restored.png') })
    await page.goto('about:blank')
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('names Text and Sticky nodes independently and restores names after restart', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-node-name-browser-profile')
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
    await page.evaluate(async ({ canvasId, textId, stickyId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Node Name Foundation', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await harness.createTextNode({ id: textId, canvasId, content: { type: 'text', text: '' }, x: 320, y: 220, createdAtMs: 110 })
      await harness.createCanvasNode({ id: stickyId, canvasId, type: 'sticky', content: { type: 'sticky', text: '' }, x: 820, y: 300, createdAtMs: 120 })
      await harness.shutdown()
    }, { canvasId: NAME_CANVAS_ID, textId: NAME_TEXT_ID, stickyId: NAME_STICKY_ID })

    await page.goto(`${baseURL}/canvas/${NAME_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Name Foundation' })).toBeVisible()
    const textNode = page.locator(`.react-flow__node[data-id="${NAME_TEXT_ID}"]`)
    const stickyNode = page.locator(`.react-flow__node[data-id="${NAME_STICKY_ID}"]`)
    const viewport = page.locator('.react-flow__viewport')
    await expect(textNode.getByText('未命名节点')).toBeVisible()
    await expect(stickyNode.getByText('未命名节点')).toBeVisible()
    await expect(textNode.getByText('TEXT')).toBeVisible()
    await expect(stickyNode.getByText('STICKY')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('01-node-name-unnamed.png') })

    await textNode.click({ position: { x: 90, y: 18 } })
    await expect(textNode).toHaveClass(/selected/)
    const viewportBeforeNameTyping = await viewport.getAttribute('style')
    await page.keyboard.press('F2')
    const textNameInput = textNode.getByRole('textbox', { name: '节点名称' })
    await expect(textNameInput).toBeVisible()
    await textNameInput.fill('WASD test')
    expect(await viewport.getAttribute('style')).toBe(viewportBeforeNameTyping)
    await textNameInput.press('Escape')
    await expect(textNode.getByText('未命名节点')).toBeVisible()

    await page.keyboard.press('F2')
    await textNode.getByRole('textbox', { name: '节点名称' }).fill('产品构思')
    await textNode.getByRole('textbox', { name: '节点名称' }).press('Enter')
    await expect(textNode.getByText('产品构思')).toBeVisible()
    await expect(page.getByRole('status')).toContainText('节点名称已保存')
    await page.screenshot({ path: testInfo.outputPath('02-text-node-name.png') })

    await stickyNode.getByText('未命名节点').dblclick()
    const stickyNameInput = stickyNode.getByRole('textbox', { name: '节点名称' })
    await stickyNameInput.fill('灵感记录')
    await page.getByRole('heading', { name: 'Node Name Foundation' }).click()
    await expect(stickyNode.getByText('灵感记录')).toBeVisible()
    await expect(page.getByRole('status')).toContainText('节点名称已保存')
    await page.screenshot({ path: testInfo.outputPath('03-sticky-node-name.png') })

    await textNode.getByText('产品构思').dblclick()
    await expect(textNode.getByRole('textbox', { name: '节点名称' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('04-node-name-inline-edit.png') })
    await textNode.getByRole('textbox', { name: '节点名称' }).press('Escape')

    const textContent = textNode.getByRole('textbox', { name: '文字节点内容' })
    const stickyContent = stickyNode.getByRole('textbox', { name: '便签节点内容' })
    await textContent.fill('正文与名称独立')
    await textContent.press('Tab')
    await stickyContent.fill('便签正文保持独立')
    await stickyContent.press('Tab')
    await expect(textNode.getByText('产品构思')).toBeVisible()
    await expect(stickyNode.getByText('灵感记录')).toBeVisible()

    const source = textNode.getByLabel('从此节点创建连线')
    const target = stickyNode.getByLabel('连接到此节点')
    const sourceBox = await source.boundingBox()
    const targetBox = await target.boundingBox()
    if (sourceBox === null || targetBox === null) throw new Error('Node handles are not visible.')
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('06-text-sticky-edge.png') })

    await textNode.click({ position: { x: 70, y: 18 } })
    await stickyNode.click({ modifiers: ['Control'], position: { x: 70, y: 18 } })
    await expect(textNode).toHaveClass(/selected/)
    await expect(stickyNode).toHaveClass(/selected/)
    await page.screenshot({ path: testInfo.outputPath('05-text-sticky-multi-select.png') })

    const textBefore = await textNode.boundingBox()
    const stickyBefore = await stickyNode.boundingBox()
    if (textBefore === null || stickyBefore === null) throw new Error('Named nodes are not visible.')
    await page.mouse.move(textBefore.x + 80, textBefore.y + 18)
    await page.mouse.down()
    await page.mouse.move(textBefore.x + 180, textBefore.y + 88, { steps: 12 })
    await page.mouse.up()
    await expect(page.getByRole('status')).toContainText('已移动 2 个节点')
    const persistedTextPosition = await textNode.evaluate((element) => (element as HTMLElement).style.transform)
    const persistedStickyPosition = await stickyNode.evaluate((element) => (element as HTMLElement).style.transform)

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Node Name Foundation' })).toBeVisible()
    const restoredText = page.locator(`.react-flow__node[data-id="${NAME_TEXT_ID}"]`)
    const restoredSticky = page.locator(`.react-flow__node[data-id="${NAME_STICKY_ID}"]`)
    await expect(restoredText.getByText('产品构思')).toBeVisible()
    await expect(restoredSticky.getByText('灵感记录')).toBeVisible()
    await expect(restoredText.getByRole('textbox', { name: '文字节点内容' })).toHaveValue('正文与名称独立')
    await expect(restoredSticky.getByRole('textbox', { name: '便签节点内容' })).toHaveValue('便签正文保持独立')
    await expect.poll(() => restoredText.evaluate((element) => (element as HTMLElement).style.transform)).toBe(persistedTextPosition)
    await expect.poll(() => restoredSticky.evaluate((element) => (element as HTMLElement).style.transform)).toBe(persistedStickyPosition)
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('07-node-name-restart.png') })
    await page.goto('about:blank')
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('configures semantic Edge types and restores them from OPFS', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-semantic-edge-browser-profile')
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
    await page.evaluate(async ({ canvasId, textId, stickyId, secondStickyId, edgeId, reverseEdgeId, stickyEdgeId, conflictEdgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const expectFailure = async (operation: Promise<unknown>, expected: string) => {
        try {
          await operation
        } catch (error: unknown) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === expected) return
          throw error
        }
        throw new Error(`Expected ${expected}.`)
      }
      await harness.createCanvas({ id: canvasId, title: '语义连线画布', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 200 })
      await harness.createTextNode({ id: textId, canvasId, nodeName: '父级文本', content: { type: 'text', text: '规划' }, x: 360, y: 300, createdAtMs: 210 })
      await harness.createCanvasNode({ id: stickyId, canvasId, type: 'sticky', nodeName: '同级便签', content: { type: 'sticky', text: '执行' }, x: 920, y: 360, createdAtMs: 220 })
      await harness.createCanvasNode({ id: secondStickyId, canvasId, type: 'sticky', content: { type: 'sticky', text: '复核' }, x: 1180, y: 620, createdAtMs: 221 })
      await harness.renameCanvasNode({ canvasId, id: textId, nodeName: '父级文本', updatedAtMs: 221 })
      await harness.renameCanvasNode({ canvasId, id: stickyId, nodeName: '同级便签', updatedAtMs: 222 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: textId, targetNodeId: stickyId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 230 })
      await harness.createCanvasEdge({ id: reverseEdgeId, canvasId, sourceNodeId: stickyId, targetNodeId: textId, relationType: 'peer', direction: 'none', lineStyle: 'solid', createdAtMs: 231 })
      await harness.createCanvasEdge({ id: stickyEdgeId, canvasId, sourceNodeId: stickyId, targetNodeId: secondStickyId, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', createdAtMs: 232 })
      await harness.createCanvasEdge({ id: conflictEdgeId, canvasId, sourceNodeId: textId, targetNodeId: stickyId, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', createdAtMs: 233 })
      await expectFailure(harness.updateCanvasEdgeRelationType({ id: edgeId, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', updatedAtMs: 234 }), 'DUPLICATE')
      const rolledBack = (await harness.listCanvasEdges(canvasId)).find((edge) => edge.id === edgeId)
      if (rolledBack?.relationType !== 'default' || rolledBack.direction !== 'forward' || rolledBack.lineStyle !== 'solid' || rolledBack.updatedAtMs !== 230) {
        throw new Error('Semantic Edge conflict did not roll back atomically.')
      }
      await harness.deleteCanvasEdge({ id: reverseEdgeId, deletedAtMs: 235, updatedAtMs: 235 })
      await harness.deleteCanvasEdge({ id: stickyEdgeId, deletedAtMs: 236, updatedAtMs: 236 })
      await harness.deleteCanvasEdge({ id: conflictEdgeId, deletedAtMs: 237, updatedAtMs: 237 })
      await harness.shutdown()
    }, {
      canvasId: SEMANTIC_CANVAS_ID,
      textId: SEMANTIC_TEXT_ID,
      stickyId: SEMANTIC_STICKY_ID,
      secondStickyId: SEMANTIC_SECOND_STICKY_ID,
      edgeId: SEMANTIC_EDGE_ID,
      reverseEdgeId: SEMANTIC_REVERSE_EDGE_ID,
      stickyEdgeId: SEMANTIC_STICKY_EDGE_ID,
      conflictEdgeId: SEMANTIC_CONFLICT_EDGE_ID,
    })

    await page.goto(`${baseURL}/canvas/${SEMANTIC_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: '语义连线画布' })).toBeVisible()
    const edge = page.locator(`.react-flow__edge[data-id="${SEMANTIC_EDGE_ID}"]`)
    await expect(edge).toBeVisible()
    await edge.click({ force: true })
    const toolbar = page.getByRole('complementary', { name: '连线设置' })
    await expect(toolbar.getByRole('heading', { name: '普通关系' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('01-default-relation.png') })

    await toolbar.getByRole('button', { name: '上下级' }).click()
    await expect(toolbar.getByRole('heading', { name: '上下级' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '单向' })).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbar.getByRole('button', { name: '实线' })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('02-hierarchy-forward.png') })

    await page.reload()
    await expect(page.getByRole('heading', { name: '语义连线画布' })).toBeVisible()
    await page.locator(`.react-flow__edge[data-id="${SEMANTIC_EDGE_ID}"]`).click({ force: true })
    const hierarchyToolbar = page.getByRole('complementary', { name: '连线设置' })
    await expect(hierarchyToolbar.getByRole('heading', { name: '上下级' })).toBeVisible()
    await expect(hierarchyToolbar.getByRole('button', { name: '单向' })).toHaveAttribute('aria-pressed', 'true')
    await expect(hierarchyToolbar.getByRole('button', { name: '实线' })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('03-hierarchy-restart.png') })

    await hierarchyToolbar.getByRole('button', { name: '同级' }).click()
    await expect(hierarchyToolbar.getByRole('heading', { name: '同级' })).toBeVisible()
    await expect(hierarchyToolbar.getByRole('button', { name: '无方向' })).toHaveAttribute('aria-pressed', 'true')
    await expect(hierarchyToolbar.getByRole('button', { name: '实线' })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('04-peer-default.png') })
    await hierarchyToolbar.getByRole('button', { name: '双向' }).click()
    await hierarchyToolbar.getByRole('button', { name: '虚线' }).click()
    await expect(hierarchyToolbar.getByRole('heading', { name: '同级' })).toBeVisible()
    await expect(hierarchyToolbar.getByRole('button', { name: '双向' })).toHaveAttribute('aria-pressed', 'true')
    await expect(hierarchyToolbar.getByRole('button', { name: '虚线' })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('05-peer-independent-visuals.png') })

    await page.reload()
    await expect(page.getByRole('heading', { name: '语义连线画布' })).toBeVisible()
    const restoredEdge = page.locator(`.react-flow__edge[data-id="${SEMANTIC_EDGE_ID}"]`)
    await restoredEdge.click({ force: true })
    const restoredToolbar = page.getByRole('complementary', { name: '连线设置' })
    await expect(restoredToolbar.getByRole('heading', { name: '同级' })).toBeVisible()
    await expect(restoredToolbar.getByRole('button', { name: '双向' })).toHaveAttribute('aria-pressed', 'true')
    await expect(restoredToolbar.getByRole('button', { name: '虚线' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(`.react-flow__node[data-id="${SEMANTIC_TEXT_ID}"]`).getByText('父级文本')).toBeVisible()
    await expect(page.locator(`.react-flow__node[data-id="${SEMANTIC_STICKY_ID}"]`).getByText('同级便签')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('06-peer-restart.png') })
    await page.goto('about:blank')
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('organizes live Canvas nodes in ordered and unordered Node Box sections', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-node-box-browser-profile')
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
    await page.evaluate(async ({ canvasId, textId, stickyId, extraId, boxId, emptyBoxId, ordinaryEdgeId, orderedEdgeId, unorderedEdgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Node Box Foundation', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 300 })
      await harness.createCanvasNode({ id: textId, canvasId, type: 'text', content: { type: 'text', text: '核心问题' }, x: 260, y: 220, createdAtMs: 310 })
      await harness.createCanvasNode({ id: stickyId, canvasId, type: 'sticky', content: { type: 'sticky', text: '参考材料' }, x: 260, y: 520, createdAtMs: 311 })
      await harness.createCanvasNode({ id: extraId, canvasId, type: 'text', content: { type: 'text', text: '下一步' }, x: 760, y: 650, createdAtMs: 312 })
      await harness.createCanvasNode({ id: boxId, canvasId, type: 'node_box', content: { type: 'node_box' }, x: 950, y: 240, createdAtMs: 313 })
      await harness.createCanvasNode({ id: emptyBoxId, canvasId, type: 'node_box', content: { type: 'node_box' }, x: 1350, y: 240, createdAtMs: 314 })
      await harness.renameCanvasNode({ canvasId, id: textId, nodeName: '研究问题', updatedAtMs: 320 })
      await harness.renameCanvasNode({ canvasId, id: stickyId, nodeName: '参考资料', updatedAtMs: 321 })
      await harness.renameCanvasNode({ canvasId, id: extraId, nodeName: '行动项', updatedAtMs: 322 })
      await harness.renameCanvasNode({ canvasId, id: boxId, nodeName: '研究盒', updatedAtMs: 323 })
      await harness.renameCanvasNode({ canvasId, id: emptyBoxId, nodeName: '空节点盒', updatedAtMs: 324 })
      await harness.createCanvasEdge({ id: ordinaryEdgeId, canvasId, sourceNodeId: textId, targetNodeId: stickyId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 329 })
      await harness.addCanvasNodeBoxMember({ id: orderedEdgeId, canvasId, sourceNodeId: textId, targetNodeId: boxId, relationType: 'ordered_box_member', createdAtMs: 330 })
      await harness.addCanvasNodeBoxMember({ id: unorderedEdgeId, canvasId, sourceNodeId: stickyId, targetNodeId: boxId, relationType: 'unordered_box_member', createdAtMs: 331 })
      await harness.shutdown()
    }, {
      canvasId: BOX_CANVAS_ID,
      textId: BOX_TEXT_ID,
      stickyId: BOX_STICKY_ID,
      extraId: BOX_EXTRA_ID,
      boxId: BOX_NODE_ID,
      emptyBoxId: BOX_EMPTY_ID,
      ordinaryEdgeId: BOX_ORDINARY_EDGE_ID,
      orderedEdgeId: BOX_ORDERED_EDGE_ID,
      unorderedEdgeId: BOX_UNORDERED_EDGE_ID,
    })

    await page.goto(`${baseURL}/canvas/${BOX_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Box Foundation' })).toBeVisible()
    const boxNode = page.locator(`.react-flow__node[data-id="${BOX_NODE_ID}"]`)
    const textNode = page.locator(`.react-flow__node[data-id="${BOX_TEXT_ID}"]`)
    const stickyNode = page.locator(`.react-flow__node[data-id="${BOX_STICKY_ID}"]`)
    const extraNode = page.locator(`.react-flow__node[data-id="${BOX_EXTRA_ID}"]`)
    const emptyBoxNode = page.locator(`.react-flow__node[data-id="${BOX_EMPTY_ID}"]`)
    await expect(boxNode.getByText('BOX')).toBeVisible()
    await expect(boxNode.getByText('有序成员')).toBeVisible()
    await expect(boxNode.getByText('无序成员')).toBeVisible()
    await expect(boxNode.getByText('研究问题')).toBeVisible()
    await expect(boxNode.getByText('参考资料')).toBeVisible()
    await expect(emptyBoxNode.getByText('空节点盒')).toBeVisible()
    await expect(emptyBoxNode.getByText('暂无成员')).toHaveCount(2)
    await expect(page.locator('.react-flow__edge')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath('01-node-box-membership.png') })
    await page.locator(`.react-flow__edge[data-id="${BOX_ORDERED_EDGE_ID}"] .react-flow__edge-path`).click({ force: true })
    const edgeSettings = page.getByLabel('连线设置')
    await expect(edgeSettings.getByRole('heading', { name: '有序成员' })).toBeVisible()
    await expect(edgeSettings.getByText('成员关系的方向与线型固定，由节点盒维护。')).toBeVisible()
    await expect(edgeSettings.getByRole('button', { name: '双向' })).toHaveCount(0)
    await expect(edgeSettings.getByRole('button', { name: '虚线' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('01b-membership-edge-settings.png') })

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Node Box Foundation' })).toBeVisible()
    await expect(boxNode.getByText('研究问题')).toBeVisible()
    await expect(boxNode.getByText('参考资料')).toBeVisible()
    await expect(page.locator('.react-flow__edge')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath('02-node-box-restart.png') })

    const textBeforeBoxMove = await textNode.boundingBox()
    const boxBeforeMove = await boxNode.boundingBox()
    if (textBeforeBoxMove === null || boxBeforeMove === null) {
      throw new Error('Node Box move audit nodes are not visible.')
    }
    await page.mouse.move(boxBeforeMove.x + 90, boxBeforeMove.y + 18)
    await page.mouse.down()
    await page.mouse.move(boxBeforeMove.x + 170, boxBeforeMove.y + 48, { steps: 10 })
    await page.mouse.up()
    await expect(page.getByRole('status')).toContainText('节点位置已保存')
    const textAfterBoxMove = await textNode.boundingBox()
    const boxAfterMove = await boxNode.boundingBox()
    if (textAfterBoxMove === null || boxAfterMove === null) {
      throw new Error('Node Box move audit nodes disappeared.')
    }
    expect(Math.abs(textAfterBoxMove.x - textBeforeBoxMove.x)).toBeLessThan(1)
    expect(Math.abs(textAfterBoxMove.y - textBeforeBoxMove.y)).toBeLessThan(1)
    expect(boxAfterMove.x - boxBeforeMove.x).toBeGreaterThan(60)
    await page.screenshot({ path: testInfo.outputPath('02b-node-box-move-not-group.png') })

    await textNode.getByText('研究问题').dblclick()
    const nameInput = textNode.getByRole('textbox', { name: '节点名称' })
    await nameInput.fill('更新后的研究问题')
    await nameInput.press('Enter')
    await expect(boxNode.getByText('更新后的研究问题')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('03-node-box-live-rename.png') })

    await boxNode.getByRole('button', { name: '移除成员 参考资料' }).click()
    await expect(boxNode.getByText('参考资料')).not.toBeVisible()
    await expect(stickyNode).toBeVisible()
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath('04-node-box-remove.png') })

    await extraNode.click({ position: { x: 90, y: 18 } })
    await boxNode.click({ modifiers: ['Control'], position: { x: 90, y: 18 } })
    await expect(extraNode).toHaveClass(/selected/)
    await expect(boxNode).toHaveClass(/selected/)
    const membershipActions = page.getByLabel('节点盒成员操作')
    await expect(membershipActions).toBeVisible()
    await membershipActions.getByRole('button', { name: '有序' }).click()
    await expect(boxNode.getByText('行动项')).toBeVisible()
    await expect(page.locator('.react-flow__edge')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath('05-node-box-mixed-selection.png') })
    await membershipActions.getByRole('button', { name: '无序' }).click()
    await expect(page.getByRole('status')).toContainText('该节点已经属于此节点盒')
    await expect(page.locator('.react-flow__edge')).toHaveCount(3)

    const extraBefore = await extraNode.boundingBox()
    if (extraBefore === null) throw new Error('Mixed selection is not visible.')
    await page.mouse.move(extraBefore.x + 90, extraBefore.y + 18)
    await page.mouse.down()
    await page.mouse.move(extraBefore.x + 190, extraBefore.y + 88, { steps: 12 })
    await page.mouse.up()
    await expect(page.getByRole('status')).toContainText('已移动 2 个节点')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Node Box Foundation' })).toBeVisible()
    const restoredBox = page.locator(`.react-flow__node[data-id="${BOX_NODE_ID}"]`)
    await expect(restoredBox.getByText('更新后的研究问题')).toBeVisible()
    await expect(restoredBox.getByText('行动项')).toBeVisible()
    await expect(restoredBox.getByText('参考资料')).not.toBeVisible()
    await expect(page.locator(`.react-flow__node[data-id="${BOX_STICKY_ID}"]`)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('06-node-box-collective-restart.png') })

    page = await openHarnessPage(context, baseURL)
    const persisted = await page.evaluate(async (canvasId) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return {
        nodes: await harness.listCanvasNodes(canvasId),
        edges: await harness.listCanvasEdges(canvasId),
      }
    }, BOX_CANVAS_ID)
    expect(persisted.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: BOX_STICKY_ID }),
      expect.objectContaining({ id: BOX_NODE_ID, type: 'node_box', content: { type: 'node_box' } }),
    ]))
    expect(persisted.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: BOX_ORDINARY_EDGE_ID, relationType: 'default', membershipPosition: null }),
      expect.objectContaining({ sourceNodeId: BOX_TEXT_ID, relationType: 'ordered_box_member', membershipPosition: 0 }),
      expect.objectContaining({ sourceNodeId: BOX_EXTRA_ID, relationType: 'ordered_box_member', membershipPosition: 1 }),
    ]))
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('reorders Node Box sections atomically and restores the exact order after restart', async ({ browserName }, testInfo) => {
  test.setTimeout(150_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-node-box-reorder-profile')
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
    await page.evaluate(async ({ canvasId, nodeIds, boxIds, edgeIds, ordinaryEdgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Node Box Reorder', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 400 })
      const names = ['A', 'B', 'C', 'D', 'E', 'F']
      for (const [index, id] of nodeIds.entries()) {
        await harness.createCanvasNode({
          id,
          canvasId,
          type: index % 2 === 0 ? 'text' : 'sticky',
          content: { type: index % 2 === 0 ? 'text' : 'sticky', text: names[index] },
          x: 120 + (index % 3) * 230,
          y: 170 + Math.floor(index / 3) * 310,
          createdAtMs: 410 + index,
        })
        await harness.renameCanvasNode({ canvasId, id, nodeName: names[index], updatedAtMs: 430 + index })
      }
      for (const [index, id] of boxIds.entries()) {
        await harness.createCanvasNode({ id, canvasId, type: 'node_box', content: { type: 'node_box' }, x: 900 + index * 380, y: 220, createdAtMs: 450 + index })
        await harness.renameCanvasNode({ canvasId, id, nodeName: index === 0 ? '主节点盒' : '第二节点盒', updatedAtMs: 460 + index })
      }
      const memberships = [
        [edgeIds[0], nodeIds[0], boxIds[0], 'ordered_box_member'],
        [edgeIds[1], nodeIds[1], boxIds[0], 'ordered_box_member'],
        [edgeIds[2], nodeIds[2], boxIds[0], 'ordered_box_member'],
        [edgeIds[3], nodeIds[3], boxIds[0], 'unordered_box_member'],
        [edgeIds[4], nodeIds[4], boxIds[1], 'ordered_box_member'],
        [edgeIds[5], nodeIds[5], boxIds[1], 'ordered_box_member'],
      ] as const
      for (const [index, [id, sourceNodeId, targetNodeId, relationType]] of memberships.entries()) {
        await harness.addCanvasNodeBoxMember({ id, canvasId, sourceNodeId, targetNodeId, relationType, createdAtMs: 470 + index })
      }
      await harness.createCanvasEdge({ id: ordinaryEdgeId, canvasId, sourceNodeId: nodeIds[0], targetNodeId: nodeIds[1], relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 480 })
      await harness.shutdown()
    }, {
      canvasId: REORDER_CANVAS_ID,
      nodeIds: REORDER_NODE_IDS,
      boxIds: REORDER_BOX_IDS,
      edgeIds: REORDER_EDGE_IDS,
      ordinaryEdgeId: REORDER_ORDINARY_EDGE_ID,
    })

    await page.goto(`${baseURL}/canvas/${REORDER_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Box Reorder' })).toBeVisible()
    const mainBox = page.locator(`.react-flow__node[data-id="${REORDER_BOX_IDS[0]}"]`)
    const secondBox = page.locator(`.react-flow__node[data-id="${REORDER_BOX_IDS[1]}"]`)
    const memberNames = async (box: typeof mainBox, sectionName: string) => {
      const section = box.getByRole('heading', { name: sectionName }).locator('..')
      return section.locator('li[aria-label^="拖动成员 "] span[title]').allTextContents()
    }
    const dragToRow = async (sourceName: string, targetName: string, before: boolean) => {
      const source = mainBox.getByLabel(`拖动成员 ${sourceName}`)
      const target = mainBox.getByLabel(`拖动成员 ${targetName}`)
      await expect(source).toHaveAttribute('draggable', 'true')
      const bounds = await target.boundingBox()
      if (bounds === null) throw new Error('Node Box member drop target is not visible.')
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      const clientY = before ? bounds.y + 2 : bounds.y + Math.max(2, bounds.height - 2)
      await source.dispatchEvent('dragstart', { dataTransfer })
      await target.dispatchEvent('dragover', { clientY, dataTransfer })
      await target.dispatchEvent('drop', { clientY, dataTransfer })
      await source.dispatchEvent('dragend', { dataTransfer })
      await dataTransfer.dispose()
      await expect(page.getByRole('status')).toContainText('成员顺序已保存')
    }
    const positionAuditNodeIds = [
      ...REORDER_NODE_IDS.slice(0, 4),
      REORDER_BOX_IDS[0],
    ]
    const positionsBefore = await Promise.all(
      positionAuditNodeIds.map((id) =>
        page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox(),
      ),
    )

    expect(await memberNames(mainBox, '有序成员')).toEqual(['A', 'B', 'C'])
    expect(await memberNames(mainBox, '无序成员')).toEqual(['D'])
    expect(await memberNames(secondBox, '有序成员')).toEqual(['E', 'F'])
    await dragToRow('C', 'A', true)
    await expect.poll(() => memberNames(mainBox, '有序成员')).toEqual(['C', 'A', 'B'])
    await dragToRow('A', 'D', false)
    await expect.poll(() => memberNames(mainBox, '无序成员')).toEqual(['D', 'A'])
    await dragToRow('A', 'D', true)
    await expect.poll(() => memberNames(mainBox, '无序成员')).toEqual(['A', 'D'])
    await dragToRow('D', 'B', true)
    await expect.poll(() => memberNames(mainBox, '有序成员')).toEqual(['C', 'D', 'B'])
    await expect.poll(() => memberNames(mainBox, '无序成员')).toEqual(['A'])

    const positionsAfter = await Promise.all(
      positionAuditNodeIds.map((id) =>
        page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox(),
      ),
    )
    expect(positionsAfter).toEqual(positionsBefore)
    await expect(page.locator(`.react-flow__edge[data-id="${REORDER_ORDINARY_EDGE_ID}"]`)).toHaveCount(1)
    await expect(page.locator('.react-flow__edge-text').filter({ hasText: /^1$/ })).toHaveCount(2)
    await expect(page.locator('.react-flow__edge-text').filter({ hasText: /^2$/ })).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath('07-node-box-reordered.png') })

    page = await openHarnessPage(context, baseURL)
    const persistenceAudit = await page.evaluate(async ({ canvasId, boxId, orderedIds, unorderedIds }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const before = await harness.listCanvasEdges(canvasId)
      const beforeMemberships = before.filter((edge) => edge.targetNodeId === boxId)
      const beforeUpdatedAt = beforeMemberships.map((edge) => [edge.id, edge.updatedAtMs])
      await harness.reorderCanvasNodeBoxMemberships({
        canvasId,
        nodeBoxId: boxId,
        orderedMembershipEdgeIds: orderedIds,
        unorderedMembershipEdgeIds: unorderedIds,
        updatedAtMs: 999,
      })
      const afterNoop = await harness.listCanvasEdges(canvasId)
      let rejectedIncompleteSet = false
      try {
        await harness.reorderCanvasNodeBoxMemberships({
          canvasId,
          nodeBoxId: boxId,
          orderedMembershipEdgeIds: orderedIds.slice(0, 2),
          unorderedMembershipEdgeIds: unorderedIds,
          updatedAtMs: 1000,
        })
      } catch {
        rejectedIncompleteSet = true
      }
      const afterFailure = await harness.listCanvasEdges(canvasId)
      return {
        before,
        afterNoop,
        afterFailure,
        beforeUpdatedAt,
        rejectedIncompleteSet,
      }
    }, {
      canvasId: REORDER_CANVAS_ID,
      boxId: REORDER_BOX_IDS[0],
      orderedIds: [REORDER_EDGE_IDS[2], REORDER_EDGE_IDS[3], REORDER_EDGE_IDS[1]],
      unorderedIds: [REORDER_EDGE_IDS[0]],
    })
    expect(persistenceAudit.afterNoop).toEqual(persistenceAudit.before)
    expect(persistenceAudit.afterFailure).toEqual(persistenceAudit.before)
    expect(persistenceAudit.rejectedIncompleteSet).toBe(true)

    await page.goto(`${baseURL}/canvas/${REORDER_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Box Reorder' })).toBeVisible()
    const restoredMainBox = page.locator(`.react-flow__node[data-id="${REORDER_BOX_IDS[0]}"]`)
    await expect.poll(() => memberNames(restoredMainBox, '有序成员')).toEqual(['C', 'D', 'B'])
    await expect.poll(() => memberNames(restoredMainBox, '无序成员')).toEqual(['A'])
    await page.screenshot({ path: testInfo.outputPath('08-node-box-reorder-restart.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('configures ordinary and Membership Edges through the contextual command path', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-edge-context-menu-profile')
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
    await page.evaluate(async ({ canvasId, nodeIds, boxId, edgeId, orderedEdgeId, unorderedEdgeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Edge Context Menu', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 500 })
      const names = ['产品策略', '执行路径', '验证记录']
      for (const [index, id] of nodeIds.entries()) {
        await harness.createCanvasNode({
          id,
          canvasId,
          type: index === 1 ? 'sticky' : 'text',
          content: { type: index === 1 ? 'sticky' : 'text', text: names[index] },
          x: 220 + (index % 2) * 440,
          y: 180 + Math.floor(index / 2) * 360,
          createdAtMs: 510 + index,
        })
        await harness.renameCanvasNode({ canvasId, id, nodeName: names[index], updatedAtMs: 520 + index })
      }
      await harness.createCanvasNode({ id: boxId, canvasId, type: 'node_box', content: { type: 'node_box' }, x: 1080, y: 260, createdAtMs: 530 })
      await harness.renameCanvasNode({ canvasId, id: boxId, nodeName: '关系整理', updatedAtMs: 531 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: nodeIds[0], targetNodeId: nodeIds[1], relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 540 })
      await harness.addCanvasNodeBoxMember({ id: orderedEdgeId, canvasId, sourceNodeId: nodeIds[0], targetNodeId: boxId, relationType: 'ordered_box_member', createdAtMs: 541 })
      await harness.addCanvasNodeBoxMember({ id: unorderedEdgeId, canvasId, sourceNodeId: nodeIds[2], targetNodeId: boxId, relationType: 'unordered_box_member', createdAtMs: 542 })
      await harness.shutdown()
    }, {
      canvasId: CONTEXT_CANVAS_ID,
      nodeIds: CONTEXT_NODE_IDS,
      boxId: CONTEXT_BOX_ID,
      edgeId: CONTEXT_EDGE_ID,
      orderedEdgeId: CONTEXT_ORDERED_EDGE_ID,
      unorderedEdgeId: CONTEXT_UNORDERED_EDGE_ID,
    })

    await page.goto(`${baseURL}/canvas/${CONTEXT_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Edge Context Menu' })).toBeVisible()
    const edge = (id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`)
    const openMenu = async (id: string, title: string, x = 720, y = 360) => {
      const target = edge(id)
      await expect(target).toHaveCount(1)
      await target.evaluate((element, coordinates) => {
        element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          clientX: coordinates.x,
          clientY: coordinates.y,
        }))
      }, { x, y })
      const menu = page.getByRole('menu', { name: `关系菜单：${title}` })
      await expect(menu).toBeVisible()
      return menu
    }

    let menu = await openMenu(CONTEXT_EDGE_ID, '连线设置')
    await expect(menu.getByRole('menuitemradio', { name: '普通关系' })).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemradio', { name: '单向' })).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemradio', { name: '实线' })).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: testInfo.outputPath('01-ordinary-edge-context-menu.png') })
    await menu.getByRole('menuitemradio', { name: '上下级' }).click()
    await expect(menu).toBeHidden()

    menu = await openMenu(CONTEXT_EDGE_ID, '连线设置')
    await expect(menu.getByRole('menuitemradio', { name: '上下级' })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: '双向' }).click()
    await expect(menu).toBeHidden()
    menu = await openMenu(CONTEXT_EDGE_ID, '连线设置')
    await menu.getByRole('menuitemradio', { name: '虚线' }).click()
    await expect(menu).toBeHidden()
    menu = await openMenu(CONTEXT_EDGE_ID, '连线设置')
    await expect(menu.getByRole('menuitemradio', { name: '上下级' })).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemradio', { name: '双向' })).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemradio', { name: '虚线' })).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: testInfo.outputPath('02-edge-semantic-state.png') })
    await page.keyboard.press('Escape')

    menu = await openMenu(CONTEXT_ORDERED_EDGE_ID, '有序成员')
    await expect(menu.getByText('关系类型')).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: '移到无序成员区' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('03-ordered-membership-menu.png') })
    await menu.getByRole('menuitem', { name: '移到无序成员区' }).click()
    await expect(menu).toBeHidden()
    await expect(edge(CONTEXT_ORDERED_EDGE_ID).locator('.react-flow__edge-text')).toHaveText('−')
    await page.screenshot({ path: testInfo.outputPath('05-membership-section-move.png') })

    menu = await openMenu(CONTEXT_ORDERED_EDGE_ID, '无序成员')
    await expect(menu.getByRole('menuitem', { name: '移到有序成员区' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('04-unordered-membership-menu.png') })
    await page.keyboard.press('Escape')

    menu = await openMenu(CONTEXT_UNORDERED_EDGE_ID, '无序成员')
    await menu.getByRole('menuitem', { name: '移到有序成员区' }).click()
    await expect(menu).toBeHidden()
    await expect(edge(CONTEXT_UNORDERED_EDGE_ID).locator('.react-flow__edge-text')).toHaveText('1')
    await expect(edge(CONTEXT_ORDERED_EDGE_ID).locator('.react-flow__edge-text')).toHaveText('−')

    menu = await openMenu(CONTEXT_ORDERED_EDGE_ID, '无序成员')
    await menu.getByRole('menuitem', { name: '从节点盒移除' }).click()
    await expect(menu).toBeHidden()
    await expect(edge(CONTEXT_ORDERED_EDGE_ID)).toHaveCount(0)
    await expect(page.locator(`.react-flow__node[data-id="${CONTEXT_NODE_IDS[0]}"]`)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('06-membership-remove-source-remains.png') })

    menu = await openMenu(CONTEXT_EDGE_ID, '连线设置', 1916, 1076)
    const menuBounds = await menu.boundingBox()
    if (menuBounds === null) throw new Error('Context menu bounds unavailable.')
    expect(menuBounds.x).toBeGreaterThanOrEqual(8)
    expect(menuBounds.y).toBeGreaterThanOrEqual(8)
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(1912)
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(1072)
    await page.screenshot({ path: testInfo.outputPath('07-viewport-clamped-menu.png') })

    const auditPage = await openHarnessPage(context, baseURL)
    const persisted = await auditPage.evaluate(async (canvasId) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return harness.listCanvasEdges(canvasId)
    }, CONTEXT_CANVAS_ID)
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: CONTEXT_EDGE_ID, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed' }),
      expect.objectContaining({ id: CONTEXT_UNORDERED_EDGE_ID, relationType: 'ordered_box_member', membershipPosition: 0 }),
    ]))
    expect(persisted).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: CONTEXT_ORDERED_EDGE_ID }),
    ]))
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('opens Node context menus and persists atomic soft delete across restart', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  expect(browserName).toBe('chromium')
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  const profilePath = testInfo.outputPath('canvas-node-context-menu-profile')
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
    await page.evaluate(async ({ canvasId, textId, stickyId, boxId, edgeId, orderedId, unorderedId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Node Context Menu', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 600 })
      await harness.createCanvasNode({ id: textId, canvasId, type: 'text', content: { type: 'text', text: 'Text body' }, x: 180, y: 180, createdAtMs: 610 })
      await harness.renameCanvasNode({ canvasId, id: textId, nodeName: '文字概念', updatedAtMs: 611 })
      await harness.createCanvasNode({ id: stickyId, canvasId, type: 'sticky', content: { type: 'sticky', text: 'Sticky body' }, x: 620, y: 180, createdAtMs: 612 })
      await harness.renameCanvasNode({ canvasId, id: stickyId, nodeName: '便签想法', updatedAtMs: 613 })
      await harness.createCanvasNode({ id: boxId, canvasId, type: 'node_box', content: { type: 'node_box' }, x: 1060, y: 220, createdAtMs: 614 })
      await harness.renameCanvasNode({ canvasId, id: boxId, nodeName: '节点集合', updatedAtMs: 615 })
      await harness.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: textId, targetNodeId: stickyId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 620 })
      await harness.addCanvasNodeBoxMember({ id: orderedId, canvasId, sourceNodeId: textId, targetNodeId: boxId, relationType: 'ordered_box_member', createdAtMs: 621 })
      await harness.addCanvasNodeBoxMember({ id: unorderedId, canvasId, sourceNodeId: stickyId, targetNodeId: boxId, relationType: 'unordered_box_member', createdAtMs: 622 })
      await harness.shutdown()
    }, {
      canvasId: NODE_MENU_CANVAS_ID,
      textId: NODE_MENU_TEXT_ID,
      stickyId: NODE_MENU_STICKY_ID,
      boxId: NODE_MENU_BOX_ID,
      edgeId: NODE_MENU_EDGE_ID,
      orderedId: NODE_MENU_ORDERED_ID,
      unorderedId: NODE_MENU_UNORDERED_ID,
    })

    await context.close()
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    page = await openHarnessPage(context, baseURL)
    await page.goto(`${baseURL}/canvas/${NODE_MENU_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Context Menu' })).toBeVisible()
    const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`)
    const openNodeMenu = async (id: string, title: string) => {
      await node(id).click({ button: 'right' })
      const menu = page.getByRole('menu', { name: `节点菜单：${title}` })
      await expect(menu).toBeVisible()
      return menu
    }

    await page.screenshot({ path: testInfo.outputPath('01-node-and-edge-before-delete.png') })

    let menu = await openNodeMenu(NODE_MENU_TEXT_ID, '文字节点')
    await expect(menu.getByRole('textbox', { name: '节点名称' })).toHaveValue('文字概念')
    await page.screenshot({ path: testInfo.outputPath('02-text-node-context-menu.png') })
    await menu.getByRole('textbox', { name: '节点名称' }).fill('重命名文字概念')
    await menu.getByRole('button', { name: '保存节点名称' }).click()
    await expect(menu).toBeHidden()
    await expect(node(NODE_MENU_TEXT_ID).getByText('重命名文字概念')).toBeVisible()
    menu = await openNodeMenu(NODE_MENU_STICKY_ID, '便签节点')
    await expect(menu.getByRole('menuitem', { name: '删除节点' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('03-sticky-node-context-menu.png') })
    await page.keyboard.press('Escape')
    menu = await openNodeMenu(NODE_MENU_BOX_ID, '节点盒')
    await page.screenshot({ path: testInfo.outputPath('04-node-box-context-menu.png') })
    await menu.getByRole('menuitem', { name: '删除节点' }).click()
    await expect(page.getByRole('status')).toContainText('节点已删除')
    await expect(node(NODE_MENU_BOX_ID)).toHaveCount(0)
    await expect(node(NODE_MENU_TEXT_ID)).toHaveCount(1)
    await expect(node(NODE_MENU_STICKY_ID)).toHaveCount(1)
    await expect(page.locator(`.react-flow__edge[data-id="${NODE_MENU_ORDERED_ID}"]`)).toHaveCount(0)
    await expect(page.locator(`.react-flow__edge[data-id="${NODE_MENU_UNORDERED_ID}"]`)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('05-node-box-deleted-members-remain.png') })

    menu = await openNodeMenu(NODE_MENU_TEXT_ID, '文字节点')
    await menu.getByRole('menuitem', { name: '删除节点' }).click()
    await expect(node(NODE_MENU_TEXT_ID)).toHaveCount(0)
    await expect(page.locator(`.react-flow__edge[data-id="${NODE_MENU_EDGE_ID}"]`)).toHaveCount(0)
    await expect(node(NODE_MENU_STICKY_ID)).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('06-node-and-edge-deleted.png') })

    const harnessPage = await openHarnessPage(context, baseURL)
    const beforeRestart = await harnessPage.evaluate(async (canvasId) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return {
        nodes: await harness.listCanvasNodes(canvasId),
        edges: await harness.listCanvasEdges(canvasId),
      }
    }, NODE_MENU_CANVAS_ID)
    expect(beforeRestart.nodes).toEqual([
      expect.objectContaining({ id: NODE_MENU_STICKY_ID }),
    ])
    expect(beforeRestart.edges).toEqual([])
    await harnessPage.evaluate(() =>
      (window as unknown as HarnessWindow).__taskPersistenceHarness.shutdown(),
    )

    await context.close()
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })
    page = await openHarnessPage(context, baseURL)
    const afterRestart = await page.evaluate(async (canvasId) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return {
        nodes: await harness.listCanvasNodes(canvasId),
        edges: await harness.listCanvasEdges(canvasId),
      }
    }, NODE_MENU_CANVAS_ID)
    expect(afterRestart).toEqual(beforeRestart)
    await page.goto(`${baseURL}/canvas/${NODE_MENU_CANVAS_ID}`)
    await expect(page.getByRole('heading', { name: 'Node Context Menu' })).toBeVisible()
    await expect(node(NODE_MENU_STICKY_ID)).toHaveCount(1)
    await expect(node(NODE_MENU_TEXT_ID)).toHaveCount(0)
    await expect(node(NODE_MENU_BOX_ID)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('07-restart-soft-delete-restored.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})
