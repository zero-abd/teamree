/** @vitest-environment jsdom */

// A repository's setup command this Mac has not approved: shown with Run and Skip, never run unseen.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SetupAsk } from './SetupAsk'

describe('the setup a teammate committed', () => {
  it('shows the command and waits for Run or Skip, with no sentence around it', () => {
    const answer = vi.fn()
    render(<SetupAsk command="npm ci && ./scripts/bootstrap" onAnswer={answer} />)
    expect(screen.getByText('npm ci && ./scripts/bootstrap').tagName).toBe('CODE')
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Run', 'Skip'])
    expect(document.body.textContent).not.toMatch(/\.\s|\?/)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(answer.mock.calls).toEqual([[true], [false]])
  })
})
