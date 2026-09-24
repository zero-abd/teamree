/** @vitest-environment jsdom */

// The parts of the store about the window: which app-level page has the main
// area, two preferences, and the one action that asks the OS for a file manager.
// jsdom because all three need a window; the rest of the store's tests run under node.

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

const { useWorkspaceStore } = await import('./workspaceStore')
const { TERMINAL_FONT_DEFAULT_PX, TERMINAL_FONT_MAX_PX, TERMINAL_OPTIONS_DEFAULT, TERMINAL_SCROLLBACK_MAX } =
  await import('./preferences')

const INITIAL = useWorkspaceStore.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

beforeEach(() => {
  useWorkspaceStore.setState({ ...INITIAL }, true)
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'teamree')
})

describe('which page has the main area', () => {
  // One area, one occupant: separate booleans nobody cleared rendered a
  // settings page behind a pane board that was also open.
  it('gives the area to settings, taking it from everything else', () => {
    useWorkspaceStore.setState({ dashboardOpen: true, teamworkProjectId: 'p1', helpOpen: true })
    store().toggleSettings()
    expect(store().settingsOpen).toBe(true)
    expect(store().helpOpen).toBe(false)
    expect(store().dashboardOpen).toBe(false)
    expect(store().teamworkProjectId).toBeNull()
  })

  it('gives it to help on the same terms', () => {
    useWorkspaceStore.setState({ settingsOpen: true, dashboardOpen: true })
    store().toggleHelp()
    expect(store().helpOpen).toBe(true)
    expect(store().settingsOpen).toBe(false)
    expect(store().dashboardOpen).toBe(false)
  })

  // The chord that opened it closes it; a key that does nothing on the second press loses trust.
  it('gives it back when the same page is asked for twice', () => {
    store().toggleSettings()
    store().toggleSettings()
    expect(store().settingsOpen).toBe(false)

    store().toggleHelp()
    store().toggleHelp()
    expect(store().helpOpen).toBe(false)
  })

  it('closes both when the dashboard is asked for', () => {
    useWorkspaceStore.setState({ settingsOpen: true })
    store().toggleDashboard()
    expect(store().settingsOpen).toBe(false)
    expect(store().dashboardOpen).toBe(true)
  })

  it('closes both when a project’s teamwork setup is asked for', () => {
    useWorkspaceStore.setState({ helpOpen: true })
    store().openTeamwork('p1')
    expect(store().helpOpen).toBe(false)
    expect(store().teamworkProjectId).toBe('p1')
  })
})

describe('the appearance sheet', () => {
  // A sheet beside the panes, so the pages that replace them step aside.
  it('opens over the panes, taking the area back from settings, help and teamwork', () => {
    useWorkspaceStore.setState({ settingsOpen: true, helpOpen: true, teamworkProjectId: 'p1', dashboardOpen: true })
    store().showAppearance(true)
    expect(store().appearanceOpen).toBe(true)
    expect(store().settingsOpen).toBe(false)
    expect(store().helpOpen).toBe(false)
    expect(store().teamworkProjectId).toBeNull()
    expect(store().dashboardOpen).toBe(true)
  })

  it('closes when a page that replaces the panes is asked for', () => {
    for (const open of [() => store().toggleSettings(), () => store().toggleHelp(), () => store().openTeamwork('p1')]) {
      useWorkspaceStore.setState({ ...INITIAL, appearanceOpen: true }, true)
      open()
      expect(store().appearanceOpen).toBe(false)
    }
  })
})

describe('adding a project from the folder picker', () => {
  const selectProjectFolder = vi.fn<() => Promise<string | null>>()
  const addProject = vi.fn<(path: string) => Promise<'not-a-repository' | 'no-commits' | null>>()

  beforeEach(() => {
    selectProjectFolder.mockReset()
    selectProjectFolder.mockResolvedValue('/Users/ada/code/atlas')
    addProject.mockReset()
    addProject.mockResolvedValue(null)
    Object.assign(window, { teamree: { selectProjectFolder } })
    useWorkspaceStore.setState({ addProject })
  })

  it('adds the pick at once, under the folder name', async () => {
    await store().chooseProjectFolder()
    expect(addProject).toHaveBeenCalledExactlyOnceWith('/Users/ada/code/atlas')
    expect(store().dialog).toBeNull()
  })

  it('adds nothing when the picker is dismissed', async () => {
    selectProjectFolder.mockResolvedValueOnce(null)
    await store().chooseProjectFolder()
    expect(addProject).not.toHaveBeenCalled()
  })

  it('opens the refusal for a folder that cannot be a project', async () => {
    addProject.mockResolvedValueOnce('not-a-repository')
    await store().chooseProjectFolder()
    expect(store().dialog).toEqual({
      kind: 'project-refused',
      folder: '/Users/ada/code/atlas',
      refusal: 'not-a-repository'
    })
  })

  it('opens one picker however often it is asked for', async () => {
    let answer: (path: string | null) => void = () => {}
    selectProjectFolder.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const first = store().chooseProjectFolder()
    await store().chooseProjectFolder()
    expect(selectProjectFolder).toHaveBeenCalledOnce()
    answer(null)
    await first
  })

  it('says so when the picker cannot open', async () => {
    selectProjectFolder.mockRejectedValueOnce(new Error('no picker'))
    await store().chooseProjectFolder()
    expect(store().notices.map((notice) => notice.text)).toEqual(['Could not open the folder picker'])
    expect(addProject).not.toHaveBeenCalled()
  })
})

describe('the size of the text in a pane', () => {
  it('starts at what the emulator was hard-coded to before it was settable', () => {
    expect(store().terminalFontSize).toBe(TERMINAL_FONT_DEFAULT_PX)
  })

  it('holds a size a pane can be drawn at, and remembers it', () => {
    store().setTerminalFontSize(16)
    expect(store().terminalFontSize).toBe(16)
    expect(window.localStorage.getItem('teamree.terminal.fontSize')).toBe('16')
  })

  it('clamps rather than refusing, so a control cannot put a pane out of reach', () => {
    store().setTerminalFontSize(400)
    expect(store().terminalFontSize).toBe(TERMINAL_FONT_MAX_PX)
  })
})

describe('how a pane draws and reads keys', () => {
  it('changes one option, keeps the rest, and remembers all of them', () => {
    store().setTerminalOptions({ cursorStyle: 'block', optionIsMeta: true })
    expect(store().terminalOptions).toEqual({ ...TERMINAL_OPTIONS_DEFAULT, cursorStyle: 'block', optionIsMeta: true })
    expect(JSON.parse(window.localStorage.getItem('teamree.terminal.options') ?? '{}')).toMatchObject({
      cursorStyle: 'block',
      optionIsMeta: true
    })
  })

  it('holds what it is given to what a pane can use', () => {
    store().setTerminalOptions({ scrollback: 10_000_000, fontFamily: '  ' })
    expect(store().terminalOptions.scrollback).toBe(TERMINAL_SCROLLBACK_MAX)
    expect(store().terminalOptions.fontFamily).toBe(TERMINAL_OPTIONS_DEFAULT.fontFamily)
  })
})

describe('the ref a project starts new worktrees from', () => {
  it('is kept per project and written through', () => {
    store().setStartPointDefault('p1', 'develop')
    expect(store().startPointDefaults).toEqual({ p1: 'develop' })
    expect(window.localStorage.getItem('teamree.worktree.startPoints')).toBe('{"p1":"develop"}')
  })

  it('is cleared back to the base ref by clearing the field, not by an empty one', () => {
    store().setStartPointDefault('p1', 'develop')
    store().setStartPointDefault('p1', null)
    expect(store().startPointDefaults).toEqual({})
    expect(window.localStorage.getItem('teamree.worktree.startPoints')).toBe('{}')
  })
})

describe('showing a path in the file manager', () => {
  it('hands the path to the bridge and says nothing when it worked', async () => {
    const revealPath = vi.fn(async () => ({ revealed: true as const }))
    Object.assign(window, { teamree: { revealPath } })

    await store().revealInFinder('/repos/pager', 'the pager repository')

    expect(revealPath).toHaveBeenCalledWith('/repos/pager')
    expect(store().notices).toEqual([])
  })

  // `shell.showItemInFolder` on a path that is gone does nothing and says
  // nothing, so the main process checks first and its reason has to reach the notices.
  it('says why, naming what was pressed, when the path is not there', async () => {
    Object.assign(window, {
      teamree: {
        revealPath: async () => ({ revealed: false as const, reason: 'There is nothing at /repos/pager to show.' })
      }
    })

    await store().revealInFinder('/repos/pager', 'the pager checkout')

    expect(store().notices).toHaveLength(1)
    expect(store().notices[0]?.text).toBe(
      'Could not show the pager checkout: There is nothing at /repos/pager to show.'
    )
  })

  // No bridge means outside Electron (a vite preview, a test harness): say it cannot rather than throw.
  it('says it cannot rather than throwing, when there is no bridge to ask', async () => {
    await store().revealInFinder('/repos/pager', 'the pager repository')

    expect(store().notices).toHaveLength(1)
    expect(store().notices[0]?.text).toBe('Cannot open the pager repository in a file manager from this window')
  })

  it('turns a bridge that rejects into a notice rather than an unhandled rejection', async () => {
    Object.assign(window, {
      teamree: {
        revealPath: () => Promise.reject(new Error('the bridge is gone'))
      }
    })

    await store().revealInFinder('/repos/pager', 'the pager repository')

    expect(store().notices).toHaveLength(1)
    expect(store().notices[0]?.text).toContain('Could not show the pager repository')
    expect(store().notices[0]?.text).toContain('the bridge is gone')
  })
})
