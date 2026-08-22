import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ErrorInfo } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { AppErrorBoundary } from '@/components/AppErrorBoundary'

const RENDER_ERROR_MESSAGE = 'test render failure'
type CaughtErrorHandler = (error: unknown, errorInfo: ErrorInfo) => void

function ThrowingChild(): never {
  throw new Error(RENDER_ERROR_MESSAGE)
}

describe('AppErrorBoundary', () => {
  test('renders children normally without showing the fallback', () => {
    const onCaughtError = vi.fn<CaughtErrorHandler>()

    render(
      <AppErrorBoundary>
        <p>正常内容</p>
      </AppErrorBoundary>,
      { onCaughtError },
    )

    expect(screen.getByText('正常内容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCaughtError).not.toHaveBeenCalled()
  })

  test('shows an accessible fallback without exposing the error message', () => {
    const onCaughtError = vi.fn<CaughtErrorHandler>()

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
      { onCaughtError },
    )

    const fallback = screen.getByRole('alert')
    expect(
      within(fallback).getByRole('heading', { name: '应用出现问题' }),
    ).toBeInTheDocument()
    expect(
      within(fallback).getByText('当前内容暂时无法显示。你可以重试。'),
    ).toBeInTheDocument()
    expect(
      within(fallback).getByRole('button', { name: '重试' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(RENDER_ERROR_MESSAGE)).not.toBeInTheDocument()
    const caughtCall = onCaughtError.mock.calls[0]
    if (!caughtCall) {
      throw new Error('Expected React to report the caught render error')
    }

    const [caughtError, errorInfo] = caughtCall
    expect(caughtError).toBeInstanceOf(Error)
    if (!(caughtError instanceof Error)) {
      throw new Error('Expected the caught value to be an Error')
    }
    expect(caughtError.message).toBe(RENDER_ERROR_MESSAGE)
    expect(typeof errorInfo.componentStack).toBe('string')
  })

  test('retries rendering descendants after the failure condition clears', async () => {
    let shouldThrow = true
    const onCaughtError = vi.fn<CaughtErrorHandler>()
    const user = userEvent.setup()

    function RetryableChild() {
      if (shouldThrow) {
        throw new Error(RENDER_ERROR_MESSAGE)
      }

      return <p>恢复后的内容</p>
    }

    render(
      <AppErrorBoundary>
        <RetryableChild />
      </AppErrorBoundary>,
      { onCaughtError },
    )

    const retryButton = screen.getByRole('button', { name: '重试' })
    shouldThrow = false
    await user.click(retryButton)

    expect(screen.getByText('恢复后的内容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCaughtError).toHaveBeenCalled()
  })
})
