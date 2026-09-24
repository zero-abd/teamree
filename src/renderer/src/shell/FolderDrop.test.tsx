/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react'
import type { ProjectAddRefusal } from '@shared/methods'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { FolderDrop } = await import('./FolderDrop')
const { useWorkspaceStore } = await import('../state/workspaceStore')

const addProject = vi.fn<(path: string, name?: string, init?: boolean) => Promise<ProjectAddRefusal | null>>()
const openDialog = vi.fn()

/** One dragged Finder item: a folder or a file, with the path the preload would read off it. */
type Dragged = { path: string; directory: boolean }

function transfer(items: Dragged[]): DataTransfer {
  return {
    types: ['Files'],
    dropEffect: 'none',
    items: items.map((item) => {
      const file = new File([], item.path.split('/').pop() ?? '')
      paths.set(file, item.path)
      return {
        kind: 'file',
        // What the renderer can read before the drop: a folder has no type.
        type: item.directory ? '' : 'text/plain',
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: item.directory })
      }
    })
  } as unknown as DataTransfer
}

const paths = new Map<File, string>()

function drop(items: Dragged[]): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer(items) })
  window.dispatchEvent(event)
  return event
}

/** A drag event on the window carrying these items. */
function drag(type: string, items: Dragged[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer(items) })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

const overlay = (): Element | null => document.querySelector('.folder-drop')

beforeEach(() => {
  addProject.mockReset()
  addProject.mockResolvedValue(null)
  openDialog.mockReset()
  useWorkspaceStore.setState({ addProject, openDialog })
  ;(window as unknown as { teamree: unknown }).teamree = { pathForFile: (file: File) => paths.get(file) ?? '' }
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('dropping on the window', () => {
  it('lets a file drag land, so the drop is not the browser navigating to it', () => {
    render(<FolderDrop />)
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: transfer([]) })
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
  })

  it('adds each dropped folder as a project and ignores files', async () => {
    render(<FolderDrop />)
    await act(async () => {
      drop([
        { path: '/Users/ada/code/atlas', directory: true },
        { path: '/Users/ada/notes.txt', directory: false },
        { path: '/Users/ada/code/pager', directory: true }
      ])
    })
    expect(addProject.mock.calls).toEqual([['/Users/ada/code/atlas'], ['/Users/ada/code/pager']])
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('opens Add project with the refusal when a folder is not a repository', async () => {
    addProject.mockResolvedValueOnce('not-a-repository')
    render(<FolderDrop />)
    await act(async () => {
      drop([{ path: '/Users/ada/notes', directory: true }])
    })
    expect(openDialog).toHaveBeenCalledWith({
      kind: 'add-project',
      folder: '/Users/ada/notes',
      refusal: 'not-a-repository'
    })
  })

  it('says Add project over the whole window while a folder is dragged over it', () => {
    render(<FolderDrop />)
    expect(overlay()).toBeNull()
    drag('dragenter', [{ path: '/Users/ada/code/atlas', directory: true }])
    expect(overlay()?.textContent).toBe('Add project')
    // Crossing from one element to the next is an enter and a leave; the overlay stays. A leave is
    // not read for what it carries.
    drag('dragenter', [{ path: '/Users/ada/code/atlas', directory: true }])
    drag('dragleave', [])
    expect(overlay()).not.toBeNull()
    drag('dragleave', [])
    expect(overlay()).toBeNull()
  })

  it('takes the overlay down on the drop', async () => {
    render(<FolderDrop />)
    drag('dragenter', [{ path: '/Users/ada/code/atlas', directory: true }])
    await act(async () => {
      drop([{ path: '/Users/ada/code/atlas', directory: true }])
    })
    expect(overlay()).toBeNull()
  })

  // A drag cancelled outside the window can end with no leave at all; the drag's steady overs stop.
  it('takes the overlay down once the drag goes quiet', () => {
    vi.useFakeTimers()
    try {
      render(<FolderDrop />)
      drag('dragenter', [{ path: '/Users/ada/code/atlas', directory: true }])
      act(() => vi.advanceTimersByTime(1000))
      drag('dragover', [{ path: '/Users/ada/code/atlas', directory: true }])
      act(() => vi.advanceTimersByTime(1000))
      expect(overlay()).not.toBeNull()
      act(() => vi.advanceTimersByTime(1000))
      expect(overlay()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows nothing for a drag of files alone', () => {
    render(<FolderDrop />)
    drag('dragenter', [{ path: '/Users/ada/notes.txt', directory: false }])
    expect(overlay()).toBeNull()
  })

  it('stops listening once unmounted', async () => {
    const view = render(<FolderDrop />)
    view.unmount()
    await act(async () => {
      drop([{ path: '/Users/ada/code/atlas', directory: true }])
    })
    expect(addProject).not.toHaveBeenCalled()
  })
})
