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
  shutdown(): Promise<void>
}

type HarnessWindow = Window & { __taskPersistenceHarness: CanvasHarness }
const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const NODE_ID = '00000000-0000-4000-8000-000000000602'

async function openHarnessPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(`${baseURL}/tests/e2e/persistence.html`)
  await page.waitForFunction(() => '__taskPersistenceHarness' in window)
  return page
}

test('persists Canvas text, position, and viewport in OPFS across restart', async ({ browserName }, testInfo) => {
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
    await page.evaluate(async ({ canvasId, nodeId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      await harness.createCanvas({ id: canvasId, title: 'Canvas Restart', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await harness.createTextNode({ id: nodeId, canvasId, content: { type: 'text', text: 'first' }, x: 40, y: 80, createdAtMs: 20 })
      await harness.updateTextNode({ id: nodeId, content: { type: 'text', text: 'persisted text' }, updatedAtMs: 30 })
      await harness.moveCanvasNode({ id: nodeId, x: 240, y: -60, updatedAtMs: 40 })
      await harness.updateCanvasViewport({ id: canvasId, viewport: { x: 120, y: 48, zoom: 1.35 }, updatedAtMs: 50 })
      await harness.renameCanvas({ id: canvasId, title: 'Canvas Restored', updatedAtMs: 60 })
      await harness.shutdown()
    }, { canvasId: CANVAS_ID, nodeId: NODE_ID })
    await context.close()
    context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true })
    page = await openHarnessPage(context, baseURL)
    const restored = await page.evaluate(async ({ canvasId }) => {
      const harness = (window as unknown as HarnessWindow).__taskPersistenceHarness
      return { canvases: await harness.listCanvases(), canvas: await harness.getCanvas(canvasId), nodes: await harness.listCanvasNodes(canvasId) }
    }, { canvasId: CANVAS_ID })
    expect(restored.canvases).toHaveLength(1)
    expect(restored.canvas).toMatchObject({ title: 'Canvas Restored', viewport: { x: 120, y: 48, zoom: 1.35 } })
    expect(restored.nodes).toEqual([expect.objectContaining({ id: NODE_ID, content: { type: 'text', text: 'persisted text' }, x: 240, y: -60 })])
  } finally {
    await context?.close()
    await rm(profilePath, { recursive: true, force: true })
  }
})
