import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'

import App from '@/App'

function navigateTo(path: string) {
  window.history.pushState({}, '', path)
}

describe('App smoke', () => {
  test('redirects the default entry to today and renders the application shell', async () => {
    navigateTo('/')

    render(<App />)

    await waitFor(() => expect(window.location.pathname).toBe('/today'))

    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    const main = screen.getByRole('main')

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(within(sidebar).getAllByRole('link')).toHaveLength(10)
    expect(within(main).getByRole('heading', { name: '首页' })).toBeInTheDocument()
  })

  test('navigates to tasks through the primary navigation', async () => {
    navigateTo('/today')
    const user = userEvent.setup()

    render(<App />)

    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    await user.click(within(sidebar).getByRole('link', { name: '任务' }))

    await waitFor(() => expect(window.location.pathname).toBe('/tasks'))

    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { name: '任务' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '主导航' })).toBeInTheDocument()
  })
})
