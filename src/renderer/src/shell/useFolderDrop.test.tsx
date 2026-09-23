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

const { useFolderDrop } = await import('./useFolderDrop')
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

function Host(): null {
  useFolderDrop()
  return null
}

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
    render(<Host />)
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: transfer([]) })
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
  })

  it('adds each dropped folder as a project and ignores files', async () => {
    render(<Host />)
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
    render(<Host />)
    await act(async () => {
      drop([{ path: '/Users/ada/notes', directory: true }])
    })
    expect(openDialog).toHaveBeenCalledWith({
      kind: 'add-project',
      folder: '/Users/ada/notes',
      refusal: 'not-a-repository'
    })
  })

  it('stops listening once unmounted', async () => {
    const view = render(<Host />)
    view.unmount()
    await act(async () => {
      drop([{ path: '/Users/ada/code/atlas', directory: true }])
    })
    expect(addProject).not.toHaveBeenCalled()
  })
})
