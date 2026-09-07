import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CanvasNodeContextMenu } from '@/components/canvas/CanvasNodeContextMenu'
import { createCanvasNodeContextMenuModel } from '@/canvas/contextMenuRegistry'

const NODE_ID = '00000000-0000-4000-8000-000000000602'

describe('CanvasNodeContextMenu', () => {
  test.each([
    ['text', '文字节点'],
    ['sticky', '便签节点'],
    ['node_box', '节点盒'],
  ] as const)('executes capability-specific actions for %s', async (type, title) => {
    const onCommand = vi.fn(() => Promise.resolve(true))
    const onClose = vi.fn()
    render(
      <CanvasNodeContextMenu
        busy={false}
        model={createCanvasNodeContextMenuModel({
          id: NODE_ID,
          type,
          nodeName: '旧名称',
        })}
        onClose={onClose}
        onCommand={onCommand}
        x={20}
        y={30}
      />,
    )

    const menu = screen.getByRole('menu', { name: `节点菜单：${title}` })
    await userEvent.clear(within(menu).getByRole('textbox', { name: '节点名称' }))
    await userEvent.type(within(menu).getByRole('textbox', { name: '节点名称' }), '新名称')
    await userEvent.click(within(menu).getByRole('button', { name: '保存节点名称' }))
    expect(onCommand).toHaveBeenCalledWith({
      id: 'rename_node',
      nodeId: NODE_ID,
      nodeName: '新名称',
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('keeps a failed delete menu open so the caller can preserve UI state', async () => {
    const onCommand = vi.fn(() => Promise.resolve(false))
    const onClose = vi.fn()
    render(
      <CanvasNodeContextMenu
        busy={false}
        model={createCanvasNodeContextMenuModel({
          id: NODE_ID,
          type: 'text',
          nodeName: '节点',
        })}
        onClose={onClose}
        onCommand={onCommand}
        x={20}
        y={30}
      />,
    )

    await userEvent.click(screen.getByRole('menuitem', { name: '删除节点' }))
    expect(onCommand).toHaveBeenCalledWith({ id: 'delete_node', nodeId: NODE_ID })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  test('renders unknown nodes read-only without mutation controls', () => {
    render(
      <CanvasNodeContextMenu
        busy={false}
        model={createCanvasNodeContextMenuModel({
          id: NODE_ID,
          type: 'unknown',
          nodeName: '未来节点',
        })}
        onClose={vi.fn()}
        onCommand={vi.fn()}
        x={20}
        y={30}
      />,
    )

    expect(screen.getByRole('menu', { name: '节点菜单：未知节点' })).toHaveTextContent('只读')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})
