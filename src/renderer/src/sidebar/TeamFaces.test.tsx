/** @vitest-environment jsdom */

// The team in a project's head: a face each, a card on hover, and cues that take you to the row.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeammateGlance } from './teamGlance'
import { MAX_FACES, TeamCueButtons, TeamFaces } from './TeamFaces'

afterEach(cleanup)

const teammate = (handle: string, overrides: Partial<TeammateGlance> = {}): TeammateGlance => ({
  handle,
  presence: 'online',
  heardAgoMs: 0,
  asking: 0,
  working: 0,
  askingPaneId: undefined,
  worktrees: [],
  ...overrides
})

describe('TeamFaces', () => {
  it('draws a face per teammate that says who, whether they are here and what their agents do', () => {
    render(
      <TeamFaces
        glance={[
          teammate('ana', { presence: 'away', heardAgoMs: 36_000 }),
          teammate('bo', {
            asking: 1,
            working: 1,
            worktrees: [{ id: 'w', name: 'cart', tone: 'working', word: 'working' }]
          })
        ]}
        onReveal={() => {}}
        onMore={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: 'ana, away · picture 36s old · no worktrees' })).toBeTruthy()
    const bo = screen.getByRole('button', { name: 'bo, online · 1 asking · 1 working' })
    expect(bo.querySelector('.avatar--online')?.textContent).toBe('B')
  })

  it('shows a card on hover with their worktrees and what each is doing, and hides it on leave', () => {
    render(
      <TeamFaces
        glance={[
          teammate('bo', {
            asking: 1,
            worktrees: [
              { id: 'w1', name: 'Round cart totals', tone: 'working', word: 'working' },
              { id: 'w2', name: 'Stop double charges', tone: 'waiting', word: 'asking' }
            ]
          })
        ]}
        onReveal={() => {}}
        onMore={() => {}}
      />
    )
    const face = screen.getByRole('button', { name: /^bo/ })
    fireEvent.mouseEnter(face)
    const card = screen.getByRole('tooltip')
    expect(card.querySelector('.team-card__name')?.textContent).toBe('bo')
    expect(card.querySelector('.team-card__presence')?.textContent).toBe('online')
    expect(card.querySelector('.team-card__doing')?.textContent).toBe('1 asking')
    expect([...card.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
      'Round cart totalsworking',
      'Stop double chargesasking'
    ])
    fireEvent.mouseLeave(face)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('keeps an open card up to date with what their agents are doing', () => {
    const { rerender } = render(<TeamFaces glance={[teammate('bo')]} onReveal={() => {}} onMore={() => {}} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^bo/ }))
    expect(screen.getByRole('tooltip').querySelector('.team-card__doing')?.textContent).toBe('no worktrees')
    rerender(<TeamFaces glance={[teammate('bo', { asking: 1 })]} onReveal={() => {}} onMore={() => {}} />)
    expect(screen.getByRole('tooltip').querySelector('.team-card__doing')?.textContent).toBe('1 asking')
  })

  it('goes to that teammate’s rows when a face is pressed', () => {
    const onReveal = vi.fn()
    render(<TeamFaces glance={[teammate('bo')]} onReveal={onReveal} onMore={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^bo/ }))
    expect(onReveal).toHaveBeenCalledWith('bo')
  })

  it('folds a big team into +N, which opens the team', () => {
    const onMore = vi.fn()
    const handles = ['ana', 'bo', 'cy', 'di', 'ed', 'fay']
    render(<TeamFaces glance={handles.map((handle) => teammate(handle))} onReveal={() => {}} onMore={onMore} />)
    expect(document.querySelectorAll('.avatar')).toHaveLength(MAX_FACES - 1)
    const more = screen.getByRole('button', { name: '+3' })
    expect(more.getAttribute('data-tip')).toBe('di, ed, fay')
    fireEvent.click(more)
    expect(onMore).toHaveBeenCalled()
  })

  it('draws nothing alone on the team', () => {
    const { container } = render(<TeamFaces glance={[]} onReveal={() => {}} onMore={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('TeamCueButtons', () => {
  it('says who is asking and that a handoff waits, and each goes there', () => {
    const onAsking = vi.fn()
    const onHandoff = vi.fn()
    render(
      <TeamCueButtons
        cues={{
          asking: { label: 'bo asking', count: 1, handle: 'bo', paneId: 'p' },
          handoffs: { label: 'handoff', count: 1 }
        }}
        onAsking={onAsking}
        onHandoff={onHandoff}
      />
    )
    const asking = screen.getByRole('button', { name: 'bo asking' })
    // The face says who, so the words can be short.
    expect(asking.textContent).toBe('Basking')
    fireEvent.click(asking)
    fireEvent.click(screen.getByRole('button', { name: 'handoff' }))
    expect(onAsking).toHaveBeenCalled()
    expect(onHandoff).toHaveBeenCalled()
  })

  it('draws nothing when nothing waits', () => {
    const { container } = render(
      <TeamCueButtons cues={{ asking: null, handoffs: null }} onAsking={() => {}} onHandoff={() => {}} />
    )
    expect(container.innerHTML).toBe('')
  })
})
