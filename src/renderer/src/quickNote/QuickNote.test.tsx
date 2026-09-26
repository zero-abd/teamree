/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuickNote, type QuickNoteBridge } from './QuickNote'

function bridge(over: Partial<Awaited<ReturnType<QuickNoteBridge['context']>>> = {}) {
  return {
    context: vi.fn(async () => ({
      projects: [
        { id: 'p1', name: 'teamree' },
        { id: 'p2', name: 'site' }
      ],
      projectId: 'p2',
      worktree: { id: 'w1', name: 'login-bug', projectId: 'p2' },
      ...over
    })),
    save: vi.fn(async () => ({ saved: '/repo/NOTES.md' }) as const),
    close: vi.fn()
  }
}

async function open(fake: ReturnType<typeof bridge>) {
  render(<QuickNote bridge={fake} />)
  await act(async () => {})
  return {
    note: screen.getByRole('textbox'),
    project: screen.getByRole('combobox'),
    save: screen.getByRole('button', { name: /Save/ })
  }
}

describe('QuickNote', () => {
  it('opens on the last project, with the note focused and Save off until there is text', async () => {
    const { note, project, save } = await open(bridge())
    expect((project as HTMLSelectElement).value).toBe('p2')
    expect(document.activeElement).toBe(note)
    expect(save).toHaveProperty('disabled', true)
  })

  it('saves with ⌘↩ to the chosen project', async () => {
    const fake = bridge()
    const { note, project } = await open(fake)
    fireEvent.change(project, { target: { value: 'p1' } })
    fireEvent.change(note, { target: { value: 'ship the tray' } })
    await act(async () => void fireEvent.keyDown(note, { key: 'Enter', metaKey: true }))
    expect(fake.save).toHaveBeenCalledWith({ projectId: 'p1', worktreeId: null, text: 'ship the tray' })
  })

  it('attaches the note to the window’s worktree when asked, and only in its project', async () => {
    const fake = bridge()
    const { note, project } = await open(fake)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Attach to login-bug' }))
    fireEvent.change(note, { target: { value: 'x' } })
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Save/ })))
    expect(fake.save).toHaveBeenLastCalledWith({ projectId: 'p2', worktreeId: 'w1', text: 'x' })

    fireEvent.change(project, { target: { value: 'p1' } })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('closes on Esc, and says why a save failed without closing', async () => {
    const fake = bridge()
    fake.save.mockResolvedValueOnce({ problem: '"NOTES.md" changed on disk' } as never)
    const { note } = await open(fake)
    fireEvent.change(note, { target: { value: 'x' } })
    await act(async () => void fireEvent.keyDown(note, { key: 'Enter', metaKey: true }))
    expect(screen.getByText('"NOTES.md" changed on disk')).toBeTruthy()
    expect(fake.close).not.toHaveBeenCalled()
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('goes away when left empty, and stays with text in it', async () => {
    const fake = bridge()
    const { note } = await open(fake)
    fireEvent.change(note, { target: { value: 'half a thought' } })
    fireEvent.blur(window)
    expect(fake.close).not.toHaveBeenCalled()
    fireEvent.change(note, { target: { value: '' } })
    fireEvent.blur(window)
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('offers nothing to save into with no project', async () => {
    const { save, project } = await open(bridge({ projects: [], projectId: null, worktree: null }))
    expect(project).toHaveProperty('disabled', true)
    expect(save).toHaveProperty('disabled', true)
  })
})
