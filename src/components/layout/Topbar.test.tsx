import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, test } from 'vitest'

import { Topbar } from '@/components/layout/Topbar'

describe('Topbar', () => {
  test('keeps the Canvas title on the editor child route', () => {
    render(
      <MemoryRouter initialEntries={['/canvas/00000000-0000-4000-8000-000000000601']}>
        <Topbar />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('画布')
  })
})
