import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'

interface CanvasHarness {
  capability(): Promise<{ status: string; reason?: string }>
  createCanvas(input: object): Promise<unknown>
  listCanvases(): Promise<readonly Record<string, unknown>[]>
  getCanvas(id: string): Promise<Record<string, unknown>>
  renameCanvas(input: object): Promise<unknown>
  updateCanvasViewport(input: object): Promise<unknown>
  createTextNode(input: object): Promise<unknown>
  listCanvasNodes(canvasId: string): Promise<readonly Record<string, unknown>[]>
  updateTextNode(input: object): Promise<unknown>
  moveCanvasNode(input: object): Promise<unknown>
  createCanvasEdge(input: object): Promise<Record<string, unknown>>
  listCanvasEdges(canvasId: string): Promise<readonly Record<string, unknown>[]>
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

async function openHarnessPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/tests/e2e/persistence.html`)
  await page.waitForFunction(() => '__taskPersistenceHarness' in window)
  return page
}

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
      await harness.createTextNode({ id: targetNodeId, canvasId, content: { type: 'text', text: 'second' }, x: 460, y: 180, createdAtMs: 21 })
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
      await harness.moveCanvasNode({ id: nodeId, x: 240, y: -60, updatedAtMs: 40 })
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
    expect(restored.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: NODE_ID, content: { type: 'text', text: 'persisted text' }, x: 240, y: -60 })]))
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
