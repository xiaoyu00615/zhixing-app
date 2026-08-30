import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CanvasNodeHeader } from '@/components/canvas/CanvasNodeHeader'

function renderHeader(
  options: {
    readonly nodeName?: string
    readonly typeLabel?: string
    readonly renameRequest?: number
    readonly onRename?: (id: string, nodeName: string) => Promise<boolean>
  } = {},
) {
  return render(
    <CanvasNodeHeader
      badgeClassName="badge"
      nodeId="node-1"
      nodeName={options.nodeName ?? ''}
      onRename={options.onRename ?? vi.fn(() => Promise.resolve(true))}
      renameRequest={options.renameRequest}
      typeLabel={options.typeLabel ?? 'TEXT'}
    />,
  )
}

describe('CanvasNodeHeader', () => {
  test('renders the unnamed placeholder weakly with the type badge on the right', () => {
    renderHeader()
    const placeholder = screen.getByText('未命名节点')
    const badge = screen.getByText('TEXT')
    expect(placeholder).toHaveClass('text-foreground-tertiary')
    expect(placeholder.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('renders a real Text or Sticky name independently from its read-only type badge', () => {
    const view = renderHeader({ nodeName: '产品构思' })
    expect(screen.getByText('产品构思')).toHaveClass('truncate')
    expect(screen.getByText('TEXT')).toBeInTheDocument()
    view.rerender(
      <CanvasNodeHeader
        badgeClassName="badge"
        nodeId="node-2"
        nodeName="灵感记录"
        onRename={vi.fn(() => Promise.resolve(true))}
        typeLabel="STICKY"
      />,
    )
    expect(screen.getByText('灵感记录')).toBeInTheDocument()
    expect(screen.getByText('STICKY')).toBeInTheDocument()
  })

  test('single click selects normally while double click enters inline edit', async () => {
    renderHeader({ nodeName: '产品构思' })
    await userEvent.click(screen.getByText('产品构思'))
    expect(screen.queryByRole('textbox', { name: '节点名称' })).not.toBeInTheDocument()
    await userEvent.dblClick(screen.getByText('产品构思'))
    expect(screen.getByRole('textbox', { name: '节点名称' })).toHaveValue('产品构思')
  })

  test('saves with Enter and Blur, including an empty name', async () => {
    const onRename = vi.fn(() => Promise.resolve(true))
    const view = renderHeader({ nodeName: '旧名称', onRename })
    await userEvent.dblClick(screen.getByText('旧名称'))
    const input = screen.getByRole('textbox', { name: '节点名称' })
    expect(input).toHaveClass('nodrag', 'nopan')
    await userEvent.clear(input)
    await userEvent.type(input, '产品构思{Enter}')
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('node-1', '产品构思'))

    view.rerender(
      <CanvasNodeHeader badgeClassName="badge" nodeId="node-1" nodeName="产品构思" onRename={onRename} typeLabel="TEXT" />,
    )
    await userEvent.dblClick(screen.getByText('产品构思'))
    await userEvent.clear(screen.getByRole('textbox', { name: '节点名称' }))
    await userEvent.tab()
    await waitFor(() => expect(onRename).toHaveBeenLastCalledWith('node-1', ''))
  })

  test('Escape cancels without persisting the draft', async () => {
    const onRename = vi.fn(() => Promise.resolve(true))
    renderHeader({ nodeName: '原名称', onRename })
    await userEvent.dblClick(screen.getByText('原名称'))
    const input = screen.getByRole('textbox', { name: '节点名称' })
    await userEvent.clear(input)
    await userEvent.type(input, '临时名称{Escape}')
    expect(screen.getByText('原名称')).toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
  })

  test('a rename request enters edit and a failed save restores the old name', async () => {
    const onRename = vi.fn(() => Promise.resolve(false))
    const view = renderHeader({ nodeName: '稳定名称', renameRequest: 0, onRename })
    view.rerender(
      <CanvasNodeHeader badgeClassName="badge" nodeId="node-1" nodeName="稳定名称" onRename={onRename} renameRequest={1} typeLabel="TEXT" />,
    )
    const input = await screen.findByRole('textbox', { name: '节点名称' })
    await userEvent.clear(input)
    await userEvent.type(input, '失败名称{Enter}')
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('node-1', '失败名称'))
    expect(screen.getByText('稳定名称')).toBeInTheDocument()
  })
})
