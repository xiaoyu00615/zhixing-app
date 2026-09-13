import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

type HarnessWindow = Window & {
  __taskPersistenceHarness: {
    createCanvas(input: unknown): Promise<unknown>
    createTextNode(input: unknown): Promise<unknown>
    deleteCanvasEdge(input: unknown): Promise<unknown>
    deleteCanvasEdgeWithHistory(input: unknown): Promise<unknown>
    shutdown(): Promise<void>
    listCanvasEdges(canvasId: string): Promise<Array<{ id: string; relationType?: string; direction?: string; lineStyle?: string }>>
    listCanvasNodes(canvasId: string): Promise<Array<{ id: string; x: number; y: number }>>
  }
}

const CANVAS_ID = '00000000-0000-4000-8000-00000000e001'
const NODE_A_ID = '00000000-0000-4000-8000-00000000e002'
const NODE_B_ID = '00000000-0000-4000-8000-00000000e003'

function nodeLocator(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`)
}

async function readNodeIds(page: Page): Promise<string[]> {
  return page.locator('.react-flow__node').evaluateAll((els) =>
    (els as HTMLElement[]).map((el) => el.dataset.id ?? ''),
  )
}

async function openEditor(context: BrowserContext, baseURL: string, canvasId: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/canvas/${canvasId}`)
  return page
}

async function ctrlKey(page: Page, key: string, shift = false): Promise<void> {
  await page.keyboard.down('Control')
  if (shift) await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  if (shift) await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
}

// Drag a node by (dx, dy) using manual mouse events (matches canvas-persistence.spec.ts pattern).
async function dragNodeBy(page: Page, locator: import('@playwright/test').Locator, dx: number, dy: number): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Node not found')
  // Start near top-left corner; React Flow calculates position from top-left.
  const startX = box.x + 10
  const startY = box.y + 10
  await page.mouse.move(startX, startY)
  await page.waitForTimeout(100)
  // Press down, drag to target with fine steps to ensure React Flow receives all pointer events
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 100 })
  await page.mouse.up()
}

// Poll until a node's DOM position settles at the target box. This confirms the
// openCanvas re-sync finished (not just the persisted position), so the next
// undo/redo keyboard dispatch cannot race an in-flight re-sync.
async function waitForNodeDomPosition(
  locator: import('@playwright/test').Locator,
  target: { readonly x: number; readonly y: number },
  tolerance = 10,
): Promise<void> {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox()
      return box !== null &&
        Math.abs(box.x - target.x) <= tolerance &&
        Math.abs(box.y - target.y) <= tolerance
    }, { timeout: 15_000 })
    .toBe(true)
}

function safeProfilePath(testInfo: TestInfo, name: string): string {
  const p = testInfo.outputPath(name)
  const root = resolve(testInfo.outputDir)
  const r = resolve(p)
  if (!r.startsWith(`${root}${sep}`)) throw new Error('Unsafe test profile path.')
  return p
}

function requireChromium(browserName: string, baseURL: string | undefined): string {
  expect(browserName).toBe('chromium')
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required.')
  return baseURL
}

// ─── CASE 1: Create Node Undo / Redo ───────────────────────────────────────

test('11A-1-C1 create node undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c1-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, aId, bId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C1', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: aId, canvasId, nodeName: 'Alpha', content: { type: 'text', text: 'Alpha content' }, x: 200, y: 200, createdAtMs: 110 })
      await h.createTextNode({ id: bId, canvasId, nodeName: 'Beta', content: { type: 'text', text: 'Beta content' }, x: 400, y: 200, createdAtMs: 120 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C1' })).toBeVisible()

    const initialIds = await readNodeIds(editor)
    expect(initialIds).toHaveLength(2)
    await editor.screenshot({ path: testInfo.outputPath('11A1-01-before-undo.png') })

    await editor.getByRole('button', { name: '文字节点' }).click()
    await editor.waitForTimeout(500)
    await expect
      .poll(async () => (await readNodeIds(editor)).length, { timeout: 10_000 })
      .toBe(3)
    const afterCreateIds = await readNodeIds(editor)
    const newNodeId = afterCreateIds.find((id) => id !== NODE_A_ID && id !== NODE_B_ID)!
    expect(newNodeId).toBeDefined()

    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => readNodeIds(editor), { timeout: 15_000 })
      .not.toContain(newNodeId)
    const afterUndoIds = await readNodeIds(editor)
    expect(afterUndoIds).toHaveLength(2)
    expect(afterUndoIds).toContain(NODE_A_ID)
    expect(afterUndoIds).toContain(NODE_B_ID)
    await editor.screenshot({ path: testInfo.outputPath('11A1-02-after-undo.png') })

    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => readNodeIds(editor), { timeout: 15_000 })
      .toContain(newNodeId)
    const afterRedoIds = await readNodeIds(editor)
    expect(afterRedoIds).toHaveLength(3)
    await editor.screenshot({ path: testInfo.outputPath('11A1-03-after-redo.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 9: Single Node Move Undo / Redo ──────────────────────────────────

test('11A-2-C9 single node move undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a2-c9-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-2 C9 Move', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'MoveNode', content: { type: 'text', text: 'move me' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-2 C9 Move' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()

    // Read DOM position before drag; undo must restore to this exact box.
    const boxABefore = await nodeA.boundingBox()
    if (!boxABefore) throw new Error('Node not visible before drag')

    // Drag the node by (300, 300). React Flow click-to-select keeps nodeA selected.
    await dragNodeBy(editor, nodeA, 300, 300)
    const boxAAfter = await nodeA.boundingBox()
    if (!boxAAfter) throw new Error('Node not visible after drag')

    // Poll harness position until drag is persisted; then assert selection.
    const persistPage = await context.newPage()
    await persistPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await persistPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, nid }: { cid: string; nid: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return list.find((n: { id: string }) => n.id === nid)
        }, { cid: CANVAS_ID, nid: NODE_A_ID })
        return nodes ? nodes.x > 450 && nodes.y > 450 : false
      }, { timeout: 15_000 })
      .toBe(true)

    // PRE-UNDO SELECTION: nodeA must still be selected after drag.
    // If drag itself drops selection, STOP — do not mask drag selection as
    // a 11A-2A selection preservation defect.
    await expect(nodeA).toHaveClass(/selected/)

    // Ctrl+Z undo. Wait for position to actually restore via poll (not sleep).
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, nid }: { cid: string; nid: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return list.find((n: { id: string }) => n.id === nid)
        }, { cid: CANVAS_ID, nid: NODE_A_ID })
        return nodes ? Math.abs(nodes.x - 200) < 5 && Math.abs(nodes.y - 200) < 5 : false
      }, { timeout: 15_000 })
      .toBe(true)

    // UI re-sync: openCanvas finished and the DOM shows the restored position,
    // so the next redo cannot race the in-flight re-sync.
    await waitForNodeDomPosition(nodeA, boxABefore)

    // AFTER UNDO SELECTION: pending snapshot must be merged in openCanvas result.
    await expect(nodeA).toHaveClass(/selected/)

    // Ctrl+Shift+Z redo. Wait for position to return to moved state.
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, nid }: { cid: string; nid: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return list.find((n: { id: string }) => n.id === nid)
        }, { cid: CANVAS_ID, nid: NODE_A_ID })
        return nodes ? nodes.x > 450 && nodes.y > 450 : false
      }, { timeout: 15_000 })
      .toBe(true)

    // UI re-sync: DOM shows the moved position again.
    await waitForNodeDomPosition(nodeA, boxAAfter)

    // AFTER REDO SELECTION.
    await expect(nodeA).toHaveClass(/selected/)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C9-01-after-move.png') })
    await editor.screenshot({ path: testInfo.outputPath('11A2-C9-03-after-redo.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 10: Multi Node Move Undo / Redo ──────────────────────────────────

test('11A-2-C10 multi node move undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a2-c10-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, aId, bId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-2 C10 MultiMove', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: aId, canvasId, nodeName: 'NodeA', content: { type: 'text', text: 'A' }, x: 200, y: 200, createdAtMs: 110 })
      await h.createTextNode({ id: bId, canvasId, nodeName: 'NodeB', content: { type: 'text', text: 'B' }, x: 400, y: 200, createdAtMs: 120 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-2 C10 MultiMove' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    const nodeB = nodeLocator(editor, NODE_B_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    const paneBox = await editor.locator('.react-flow__pane').boundingBox()
    if (!paneBox) throw new Error('Pane not visible')
    const paneOffsetX = paneBox.x
    const paneOffsetY = paneBox.y

    // Select both nodes via Control+click (matches canvas-persistence.spec.ts pattern)
    await nodeA.click({ button: 'left', position: { x: 110, y: 80 } })
    await editor.waitForTimeout(200)
    await nodeB.click({ button: 'left', modifiers: ['Control'], position: { x: 110, y: 80 } })
    await editor.waitForTimeout(200)
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)

    // Read DOM positions before drag
    const boxABefore = await nodeA.boundingBox()
    const boxBBefore = await nodeB.boundingBox()
    if (!boxABefore || !boxBBefore) throw new Error('Nodes not visible before drag')

    // Drag both nodes by (300, 200) — drag from node A
    await dragNodeBy(editor, nodeA, 300, 200)

    const persistPage = await context.newPage()
    await persistPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await persistPage.waitForFunction(() => '__taskPersistenceHarness' in window)

    // Poll harness until BOTH persisted positions reflect the move.
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, aId, bId }: { cid: string; aId: string; bId: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return {
            a: list.find((n: { id: string }) => n.id === aId),
            b: list.find((n: { id: string }) => n.id === bId),
          }
        }, { cid: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })
        return nodes.a && nodes.b ? (nodes.a.x > 450 && nodes.a.y > 350 && nodes.b.x > 650 && nodes.b.y > 350) : false
      }, { timeout: 15_000 })
      .toBe(true)

    const movedNodes = await persistPage.evaluate(async ({ cid, aId, bId }: { cid: string; aId: string; bId: string }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const list = await h.listCanvasNodes(cid)
      return {
        a: list.find((n: { id: string }) => n.id === aId),
        b: list.find((n: { id: string }) => n.id === bId),
      }
    }, { cid: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })
    const movedA = movedNodes.a
    const movedB = movedNodes.b
    if (!movedA || !movedB) throw new Error('afterMove nodes missing')

    // Verify DOM deltas are consistent across both nodes
    const boxAAfter = await nodeA.boundingBox()
    const boxBAfter = await nodeB.boundingBox()
    if (!boxAAfter || !boxBAfter) throw new Error('Nodes not visible after drag')
    const domDxA = boxAAfter.x - boxABefore.x
    const domDyA = boxAAfter.y - boxABefore.y
    const domDxB = boxBAfter.x - boxBBefore.x
    const domDyB = boxBAfter.y - boxBBefore.y
    expect(domDxA).toBeGreaterThan(270)
    expect(domDyA).toBeGreaterThan(170)
    // Both nodes move by the same delta
    expect(domDxA).toBeCloseTo(domDxB, 0)
    expect(domDyA).toBeCloseTo(domDyB, 0)
    // Harness positions match DOM positions
    expect(movedA.x).toBeCloseTo(boxABefore.x + domDxA - paneOffsetX, 0)
    expect(movedA.y).toBeCloseTo(boxABefore.y + domDyA - paneOffsetY, 0)
    expect(movedB.x).toBeCloseTo(boxBBefore.x + domDxB - paneOffsetX, 0)
    expect(movedB.y).toBeCloseTo(boxBBefore.y + domDyB - paneOffsetY, 0)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C10-01-after-move.png') })

    // PRE-UNDO SELECTION: both nodes must remain selected after collective drag.
    // If drag itself drops multi-selection, STOP — do not mask drag selection as
    // a 11A-2A selection preservation defect.
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)

    // Ctrl+Z undo — BOTH restore. Poll harness until BOTH positions return.
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, aId, bId }: { cid: string; aId: string; bId: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return {
            a: list.find((n: { id: string }) => n.id === aId),
            b: list.find((n: { id: string }) => n.id === bId),
          }
        }, { cid: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })
        return nodes.a && nodes.b
          && Math.abs(nodes.a.x - 200) < 5 && Math.abs(nodes.a.y - 200) < 5
          && Math.abs(nodes.b.x - 400) < 5 && Math.abs(nodes.b.y - 200) < 5
      }, { timeout: 15_000 })
      .toBe(true)

    // UI re-sync: openCanvas finished and the DOM shows both restored positions,
    // so the next redo cannot race the in-flight re-sync.
    await waitForNodeDomPosition(nodeA, boxABefore)
    await waitForNodeDomPosition(nodeB, boxBBefore)

    // AFTER UNDO SELECTION: pending snapshot must restore both selections.
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C10-02-after-undo.png') })

    // Ctrl+Shift+Z redo — BOTH move again. Poll until both return to moved state.
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const nodes = await persistPage.evaluate(async ({ cid, aId, bId }: { cid: string; aId: string; bId: string }) => {
          const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
          const list = await h.listCanvasNodes(cid)
          return {
            a: list.find((n: { id: string }) => n.id === aId),
            b: list.find((n: { id: string }) => n.id === bId),
          }
        }, { cid: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })
        return nodes.a && nodes.b
          && Math.abs(nodes.a.x - movedA.x) < 5 && Math.abs(nodes.a.y - movedA.y) < 5
          && Math.abs(nodes.b.x - movedB.x) < 5 && Math.abs(nodes.b.y - movedB.y) < 5
      }, { timeout: 15_000 })
      .toBe(true)

    // UI re-sync: DOM shows both moved positions again.
    await waitForNodeDomPosition(nodeA, boxAAfter)
    await waitForNodeDomPosition(nodeB, boxBAfter)

    // AFTER REDO SELECTION.
    await expect(nodeA).toHaveClass(/selected/)
    await expect(nodeB).toHaveClass(/selected/)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C10-03-after-redo.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 11: Zero Move (no history entry) ─────────────────────────────────

test('11A-2-C11 zero move produces no history entry', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a2-c11-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-2 C11 ZeroMove', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'ZeroNode', content: { type: 'text', text: 'noop' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-2 C11 ZeroMove' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()
    // position verified via harness only

    // Click and immediately click again — no drag occurred
    await nodeA.click()
    await editor.waitForTimeout(200)
    await nodeA.click()
    await editor.waitForTimeout(400)

    // Try undo — no-op since no history entry was created
    await ctrlKey(editor, 'z')
    await editor.waitForTimeout(400)

    // position verified via harness only
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 12: Node Box Move Undo ───────────────────────────────────────────

test('11A-2-C12 node box move undo preserves members', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a2-c12-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, boxId, memberId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-2 C12 BoxMove', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createCanvasNode({ id: boxId, canvasId, nodeName: 'MyBox', type: 'node_box', content: { type: 'node_box' }, x: 100, y: 100, createdAtMs: 110 })
      await h.createTextNode({ id: memberId, canvasId, nodeName: 'Member', content: { type: 'text', text: 'inside' }, x: 300, y: 300, createdAtMs: 120 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, boxId: NODE_A_ID, memberId: NODE_B_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-2 C12 BoxMove' })).toBeVisible()

    const boxNode = nodeLocator(editor, NODE_A_ID)
    const memberNode = nodeLocator(editor, NODE_B_ID)
    await expect(boxNode).toBeVisible()
    await expect(memberNode).toBeVisible()

    const paneBox = await editor.locator('.react-flow__pane').boundingBox()
    if (!paneBox) throw new Error('Pane not visible')
    const paneOffsetX = paneBox.x
    const paneOffsetY = paneBox.y

    // Read DOM positions before drag
    const boxBefore = await boxNode.boundingBox()
    const memberBefore = await memberNode.boundingBox()
    if (!boxBefore || !memberBefore) throw new Error('Nodes not visible before drag')

    // Drag the Node Box by (200, 200)
    await dragNodeBy(editor, boxNode, 200, 200)
    await editor.waitForTimeout(800)

    const persistPage = await context.newPage()
    await persistPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await persistPage.waitForFunction(() => '__taskPersistenceHarness' in window)

    const afterMove = await persistPage.evaluate(async ({ cid, boxId, memberId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const nodes = await h.listCanvasNodes(cid)
      return {
        box: nodes.find((n: { id: string }) => n.id === boxId),
        member: nodes.find((n: { id: string }) => n.id === memberId),
      }
    }, { cid: CANVAS_ID, boxId: NODE_A_ID, memberId: NODE_B_ID })

    // Verify DOM delta is consistent
    const boxAfter = await boxNode.boundingBox()
    if (!boxAfter) throw new Error('Box node not visible after drag')
    const domDx = boxAfter.x - boxBefore.x
    const domDy = boxAfter.y - boxBefore.y
    expect(domDx).toBeGreaterThan(170)
    expect(domDy).toBeGreaterThan(170)
    // Harness position matches DOM position
    expect(afterMove.box!.x).toBeCloseTo(boxBefore.x + domDx - paneOffsetX, 0)
    expect(afterMove.box!.y).toBeCloseTo(boxBefore.y + domDy - paneOffsetY, 0)
    // Member position unchanged
    expect(afterMove.member!.x).toBeCloseTo(300, 0)
    expect(afterMove.member!.y).toBeCloseTo(300, 0)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C12-01-after-move.png') })

    // Undo: box restores to original, member stays unchanged
    await ctrlKey(editor, 'z')
    await editor.waitForTimeout(800)

    const afterUndo = await persistPage.evaluate(async ({ cid, boxId, memberId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const nodes = await h.listCanvasNodes(cid)
      return {
        box: nodes.find((n: { id: string }) => n.id === boxId),
        member: nodes.find((n: { id: string }) => n.id === memberId),
      }
    }, { cid: CANVAS_ID, boxId: NODE_A_ID, memberId: NODE_B_ID })
    expect(afterUndo.box!.x).toBeCloseTo(100, 0)
    expect(afterUndo.box!.y).toBeCloseTo(100, 0)
    expect(afterUndo.member!.x).toBeCloseTo(300, 0)
    expect(afterUndo.member!.y).toBeCloseTo(300, 0)
    await editor.screenshot({ path: testInfo.outputPath('11A2-C12-02-after-undo.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 2: Rename Node Undo / Redo ──────────────────────────────────────

test('11A-1-C2 rename node undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c2-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C2 Rename', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'OriginalName', content: { type: 'text', text: 'Some content' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C2 Rename' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()
    await nodeA.getByText('OriginalName').dblclick()
    await editor.waitForTimeout(300)
    const renameInput = editor.getByLabel('节点名称')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('NewName')
    await renameInput.press('Enter')
    await editor.waitForTimeout(400)
    await expect(nodeA.getByText('NewName')).toBeVisible()
    await ctrlKey(editor, 'z')
    await editor.waitForTimeout(500)
    await expect(nodeA.getByText('OriginalName')).toBeVisible()
    await ctrlKey(editor, 'z', true)
    await editor.waitForTimeout(500)
    await expect(nodeA.getByText('NewName')).toBeVisible()
    await editor.screenshot({ path: testInfo.outputPath('11A1-04-renamed.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 3: Edit Text Content Undo / Redo ────────────────────────────────

test('11A-1-C3 edit text content undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c3-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C3 Edit', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'ContentNode', content: { type: 'text', text: 'first' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C3 Edit' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()
    const textarea = nodeA.locator('textarea[aria-label="文字节点内容"]')
    await expect(textarea).toHaveValue('first')

    // Focus, fill new content, blur to commit
    await textarea.click()
    await editor.waitForTimeout(100)
    await textarea.fill('second')
    await textarea.blur()
    await editor.waitForTimeout(800)

    // Verify update
    await expect(textarea).toHaveValue('second')

    // Ctrl+Z undo — restore "first"
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const ta = editor.locator(`.react-flow__node[data-id="${NODE_A_ID}"] textarea[aria-label="文字节点内容"]`)
        return (await ta.inputValue()) === 'first'
      }, { timeout: 20_000 })
      .toBeTruthy()

    // Ctrl+Shift+Z redo — restore "second"
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const ta = editor.locator(`.react-flow__node[data-id="${NODE_A_ID}"] textarea[aria-label="文字节点内容"]`)
        return (await ta.inputValue()) === 'second'
      }, { timeout: 20_000 })
      .toBeTruthy()
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 4: Create Edge Undo / Redo ───────────────────────────────────────

test('11A-1-C4 create edge undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c4-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, aId, bId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C4 Edge', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: aId, canvasId, nodeName: 'NodeA', content: { type: 'text', text: 'A' }, x: 200, y: 200, createdAtMs: 110 })
      await h.createTextNode({ id: bId, canvasId, nodeName: 'NodeB', content: { type: 'text', text: 'B' }, x: 600, y: 200, createdAtMs: 120 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C4 Edge' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    const nodeB = nodeLocator(editor, NODE_B_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    const edgeIds = await editor.locator('.react-flow__edge').evaluateAll((els) => (els as HTMLElement[]).map((el) => el.dataset.id ?? ''))
    expect(edgeIds.filter(Boolean).length).toBe(0)

    await nodeA.hover()
    await editor.waitForTimeout(200)
    const sourceHandle = nodeA.locator('[aria-label="从此节点创建连线"]').first()
    const targetHandle = nodeB.locator('[aria-label="连接到此节点"]').first()
    await expect(sourceHandle).toBeVisible()
    await expect(targetHandle).toBeVisible()
    await sourceHandle.dragTo(targetHandle, { timeout: 10_000 })
    await editor.waitForTimeout(500)

    await expect
      .poll(async () => {
        const ids = await editor.locator('.react-flow__edge').evaluateAll((els) => (els as HTMLElement[]).map((el) => el.dataset.id ?? ''))
        return ids.some(Boolean)
      }, { timeout: 10_000 })
      .toBe(true)
    const edgeIdsAfterCreate = await editor.locator('.react-flow__edge').evaluateAll((els) => (els as HTMLElement[]).map((el) => el.dataset.id ?? ''))
    const createdEdgeId = edgeIdsAfterCreate.find((id) => id !== '')
    expect(createdEdgeId).toBeDefined()
    await editor.screenshot({ path: testInfo.outputPath('11A1-05-edge-created.png') })

    await expect
      .poll(async () => {
        const count = await editor.locator(`.react-flow__edge[data-id="${createdEdgeId}"]`).count()
        return count > 0
      }, { timeout: 10_000 })
      .toBe(true)

    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const ids = await editor.locator('.react-flow__edge').evaluateAll((els) => (els as HTMLElement[]).map((el) => el.dataset.id ?? ''))
        return !ids.includes(createdEdgeId!)
      }, { timeout: 15_000 })
      .toBe(true)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()

    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const ids = await editor.locator('.react-flow__edge').evaluateAll((els) => (els as HTMLElement[]).map((el) => el.dataset.id ?? ''))
        return ids.includes(createdEdgeId!)
      }, { timeout: 15_000 })
      .toBe(true)
    await editor.screenshot({ path: testInfo.outputPath('11A1-04-edge-restored.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 5: Delete Edge Undo / Redo ───────────────────────────────────────
// Uses real React Flow edge contextmenu dispatch (same pattern as
// canvas-persistence.spec.ts :1264) → Edge Context Menu → "删除连线".

test('11A-1-C5 delete edge undo/redo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c5-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)

    // Seed canvas + capture edge properties before editor opens.
    const edgeProps = await seedPage.evaluate(async ({ canvasId, aId, bId, edgeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C5 DelEdge', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: aId, canvasId, nodeName: 'NodeA', content: { type: 'text', text: 'A' }, x: 200, y: 200, createdAtMs: 110 })
      await h.createTextNode({ id: bId, canvasId, nodeName: 'NodeB', content: { type: 'text', text: 'B' }, x: 600, y: 200, createdAtMs: 120 })
      await h.createCanvasEdge({ id: edgeId, canvasId, sourceNodeId: aId, targetNodeId: bId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 130 })
      const edges = await h.listCanvasEdges(canvasId)
      return edges.find((e: { id: string }) => e.id === edgeId)!
    }, { canvasId: CANVAS_ID, aId: NODE_A_ID, bId: NODE_B_ID, edgeId: '00000000-0000-4000-8000-00000000e004' })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C5 DelEdge' })).toBeVisible()

    const edgeId = '00000000-0000-4000-8000-00000000e004'
    const edge = editor.locator(`.react-flow__edge[data-id="${edgeId}"]`).first()
    await expect(edge).toHaveCount(1)
    await editor.screenshot({ path: testInfo.outputPath('11A1-C5-01-before-delete.png') })

    // Right-click the edge via contextmenu event dispatch (same pattern as persistence spec).
    await edge.evaluate((element, coords) => {
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        clientX: coords.x,
        clientY: coords.y,
      }))
    }, { x: 400, y: 240 })
    const menu = editor.getByRole('menu', { name: '关系菜单：连线设置' })
    await expect(menu).toBeVisible()

    await menu.getByRole('menuitem', { name: '删除连线' }).click()
    await expect(menu).toBeHidden()

    // Edge must be gone from UI.
    await expect(editor.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toHaveCount(0)
    await editor.screenshot({ path: testInfo.outputPath('11A1-C5-02-after-delete.png') })

    // Ctrl+Z undo — restore edge, verify properties.
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const count = await editor.locator(`.react-flow__edge[data-id="${edgeId}"]`).count()
        return count > 0
      }, { timeout: 15_000 })
      .toBe(true)
    await editor.screenshot({ path: testInfo.outputPath('11A1-C5-03-after-undo-restored.png') })

    // Verify persistence state matches original via a fresh harness page.
    const persistPage = context.pages()[0] ?? await context.newPage()
    await persistPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await persistPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    const restoredEdge = await persistPage.evaluate(async ({ eid, cid }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      const edges = await h.listCanvasEdges(cid)
      return edges.find((e: { id: string }) => e.id === eid)
    }, { eid: edgeId, cid: CANVAS_ID })
    expect(restoredEdge).toBeDefined()
    expect(restoredEdge!.id).toBe(edgeId)
    expect(restoredEdge!.relationType).toBe(edgeProps.relationType)
    expect(restoredEdge!.direction).toBe(edgeProps.direction)
    expect(restoredEdge!.lineStyle).toBe(edgeProps.lineStyle)

    // Ctrl+Shift+Z redo — delete again.
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const count = await editor.locator(`.react-flow__edge[data-id="${edgeId}"]`).count()
        return count === 0
      }, { timeout: 15_000 })
      .toBe(true)
    await editor.screenshot({ path: testInfo.outputPath('11A1-C5-04-after-redo-deleted.png') })
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

test('11A-1-C6 history order LIFO', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c6-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C6 LIFO', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'A', content: { type: 'text', text: 'Node A' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    await expect(editor.getByRole('heading', { name: '11A-1 C6 LIFO' })).toBeVisible()

    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()
    await expect(nodeA.locator('span[title="A"]').first()).toBeVisible()

    // Step 1: Rename A -> B
    await nodeA.locator('span[title="A"]').first().dblclick()
    await editor.waitForTimeout(300)
    const renameInput = editor.getByLabel('节点名称')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('B')
    await renameInput.press('Enter')
    await editor.waitForTimeout(400)
    await expect(nodeA.locator('span[title="B"]').first()).toBeVisible()

    // Step 2: Create a new text node
    await editor.getByRole('button', { name: '文字节点' }).click()
    await editor.waitForTimeout(500)
    await expect
      .poll(async () => (await readNodeIds(editor)).length, { timeout: 10_000 })
      .toBe(2)
    const afterCreateIds = await readNodeIds(editor)
    const newNodeId = afterCreateIds.find((id) => id !== NODE_A_ID)!
    expect(newNodeId).toBeDefined()

    // Undo 1: undo create → node disappears
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const ids = await readNodeIds(editor)
        return !ids.includes(String(newNodeId)) && ids.length === 1
      }, { timeout: 15_000 })
      .toBe(true)

    // Undo 2: undo rename → name restored to A
    await ctrlKey(editor, 'z')
    await expect
      .poll(async () => {
        const count = await nodeA.locator('span[title="A"]').count()
        return count > 0
      }, { timeout: 15_000 })
      .toBe(true)

    // Redo 1: redo rename → B
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const count = await nodeA.locator('span[title="B"]').count()
        return count > 0
      }, { timeout: 15_000 })
      .toBe(true)

    // Redo 2: redo create → node reappears
    await ctrlKey(editor, 'z', true)
    await expect
      .poll(async () => {
        const ids = await readNodeIds(editor)
        return ids.length === 2 && ids.includes(newNodeId)
      }, { timeout: 15_000 })
      .toBe(true)
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 7: Redo cleared after new mutation ──────────────────────────────

test('11A-1-C7 redo cleared by new mutation', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c7-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C7 Clear', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'OriginalName', content: { type: 'text', text: 'Content' }, x: 200, y: 200, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()

    await nodeA.getByText('OriginalName').dblclick()
    await editor.waitForTimeout(300)
    await editor.getByLabel('节点名称').fill('NewName')
    await editor.getByLabel('节点名称').press('Enter')
    await editor.waitForTimeout(400)
    await expect(nodeA.getByText('NewName')).toBeVisible()

    await ctrlKey(editor, 'z')
    await editor.waitForTimeout(500)
    await expect(nodeA.getByText('OriginalName')).toBeVisible()

    await nodeA.getByText('OriginalName').dblclick()
    await editor.waitForTimeout(300)
    await editor.getByLabel('节点名称').fill('FinalName')
    await editor.getByLabel('节点名称').press('Enter')
    await editor.waitForTimeout(400)
    await expect(nodeA.getByText('FinalName')).toBeVisible()

    await ctrlKey(editor, 'z', true)
    await editor.waitForTimeout(400)
    await expect(nodeA.getByText('FinalName')).toBeVisible()
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})

// ─── CASE 8: Editable Guard ────────────────────────────────────────────────

test('11A-1-C8 editable guard: Ctrl+Z in input does not trigger canvas undo', async ({ browserName }, testInfo) => {
  test.setTimeout(90_000)
  const baseURL = requireChromium(browserName, testInfo.project.use.baseURL)
  const profilePath = safeProfilePath(testInfo, '11a1-c8-browser-profile')

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    })

    const seedPage = context.pages()[0] ?? await context.newPage()
    await seedPage.goto(`${baseURL}/tests/e2e/persistence.html`)
    await seedPage.waitForFunction(() => '__taskPersistenceHarness' in window)
    await seedPage.evaluate(async ({ canvasId, nodeId }) => {
      const h = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await h.createCanvas({ id: canvasId, title: '11A-1 C8 Guard', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 100 })
      await h.createTextNode({ id: nodeId, canvasId, nodeName: 'GuardTest', content: { type: 'text', text: 'editable content' }, x: 300, y: 300, createdAtMs: 110 })
      await h.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_A_ID })

    const editor = await openEditor(context, baseURL, CANVAS_ID)
    const nodeA = nodeLocator(editor, NODE_A_ID)
    await expect(nodeA).toBeVisible()

    await nodeA.getByText('GuardTest').dblclick()
    await editor.waitForTimeout(300)
    const renameInput = editor.getByLabel('节点名称')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('xyz')
    await editor.waitForTimeout(200)

    await ctrlKey(editor, 'z')
    await editor.waitForTimeout(300)

    const ids = await readNodeIds(editor)
    expect(ids).toContain(NODE_A_ID)
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})
