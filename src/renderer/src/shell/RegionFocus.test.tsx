/** @vitest-environment jsdom */

// The keyboard is never left on the page: a region put away while it holds the focus hands it to
// the focused pane, and one brought back takes it.

import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { RegionFocus } = await import('./RegionFocus')
const { requestRegionFocus } = await import('./regions')

/** Enough of the window to have somewhere to go, drawn from the same two flags. */
function Window(): React.JSX.Element {
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  return (
    <>
      {sidebarVisible ? (
        <div data-region="sidebar">
          <button role="treeitem" tabIndex={0} id="row">
            Rewrite
          </button>
        </div>
      ) : null}
      <div data-region="panes">
        <section className="pane pane--focused">
          <textarea className="xterm-helper-textarea" id="pane" />
        </section>
      </div>
      <aside data-region="panel">
        {rightPanelOpen ? (
          <button role="tab" aria-selected="true" id="files">
            Files
          </button>
        ) : (
          <button role="tab" aria-selected="false" id="rail">
            Files
          </button>
        )}
      </aside>
      <RegionFocus />
    </>
  )
}

const focused = (): string | undefined => document.activeElement?.id

beforeEach(() => {
  useWorkspaceStore.setState({ sidebarVisible: true, rightPanelOpen: false })
  render(<Window />)
})

describe('a region put away while it holds the focus', () => {
  it('hands the focus to the focused pane, for the sidebar', () => {
    act(() => document.getElementById('row')?.focus())
    act(() => useWorkspaceStore.getState().toggleSidebar())
    expect(focused()).toBe('pane')
  })

  it('hands the focus to the focused pane, for the panel', () => {
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    act(() => document.getElementById('files')?.focus())
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(focused()).toBe('pane')
  })

  it('leaves the focus alone when it was somewhere else', () => {
    act(() => document.getElementById('pane')?.focus())
    act(() => useWorkspaceStore.getState().toggleSidebar())
    expect(focused()).toBe('pane')
  })
})

describe('a region brought back', () => {
  it('takes the focus, on the tree’s stop or the shown tab', () => {
    act(() => useWorkspaceStore.getState().toggleSidebar())
    act(() => useWorkspaceStore.getState().toggleSidebar())
    expect(focused()).toBe('row')
    act(() => useWorkspaceStore.getState().toggleRightPanel())
    expect(focused()).toBe('files')
  })
})

describe('asking for a region', () => {
  it('lands there once drawn', () => {
    act(() => requestRegionFocus('panes'))
    expect(focused()).toBe('pane')
    act(() => requestRegionFocus('panel'))
    expect(focused()).toBe('rail')
  })
})
