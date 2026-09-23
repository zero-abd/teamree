/** @vitest-environment jsdom */

// The page that has to be right about the rest of the app.
//
// Two things are being defended. The first is that the keyboard section is
// derived rather than described: the assertions walk `WORKSPACE_SHORTCUTS` and
// demand that the rendered page carry every entry, so adding a binding and
// forgetting this page fails here rather than in a bug report from somebody who
// could not find the key. Nothing below names a command, for the same reason.
//
// The second is the CLI section, where being wrong has a cost. A page that says
// "type teamree help" to somebody whose shell has no teamree hands them a
// `command not found`, so the section is tested in both states: the command
// when it exists, and the way to settings when it does not.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatus, PaneConsent } from '@shared/entities'
import { formatChord, resolvePlatformModifier, type Chord, type PlatformModifier } from '../keyboard/platformModifier'
import { WORKSPACE_SHORTCUTS, type WorkspaceShortcut } from '../keyboard/workspaceShortcuts'

/** The entries that are keys; the table also holds commands bound to none. */
const BOUND: readonly WorkspaceShortcut[] = WORKSPACE_SHORTCUTS.filter((shortcut) => shortcut.chord !== undefined)

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
const { HelpView } = await import('./HelpView')

const INITIAL = useWorkspaceStore.getState()

const APPLE = resolvePlatformModifier('darwin')
const PC = resolvePlatformModifier('linux')

const toggleHelp = vi.fn()
const toggleSettings = vi.fn()
const loadCli = vi.fn(async () => {})

function seed(cli: CliStatus | null = status({ state: 'linked' })): void {
  useWorkspaceStore.setState({ ...INITIAL, cli, toggleHelp, toggleSettings, loadCli }, true)
}

beforeEach(() => {
  toggleHelp.mockReset()
  toggleSettings.mockReset()
  loadCli.mockClear()
  seed()
})

describe('the keyboard section', () => {
  // Written as a loop over the real table on purpose. A list of expected
  // commands here would be the second hand-written copy of the bindings that
  // the generated section exists to avoid.
  it.each(BOUND.map((shortcut) => [shortcut.title, shortcut] as const))('lists %s', (_title, shortcut) => {
    render(<HelpView modifier={APPLE} />)
    expect(screen.getByText(shortcut.title)).toBeDefined()
    expect(screen.getByText(formatChord(shortcut.chord as Chord, APPLE)).tagName).toBe('KBD')
  })

  it('lists no more and no fewer than the table has', () => {
    const { container } = render(<HelpView modifier={APPLE} />)
    // Plus the two digit rows, which live outside the table.
    expect(container.querySelectorAll('.help-key')).toHaveLength(BOUND.length + 2)
  })

  it('lists the tab numbers under Panes', () => {
    render(<HelpView modifier={APPLE} />)
    expect(screen.getByText('Pane 1–8')).toBeDefined()
    expect(screen.getByText('⌘1–⌘8').tagName).toBe('KBD')
    expect(screen.getByText('Last pane')).toBeDefined()
    expect(screen.getByText('⌘9').tagName).toBe('KBD')
  })

  // The chords are read off the same table on both platforms, and the glyph is
  // the only thing that differs. A page that spelled them for one platform
  // would be telling half its readers to press a key they do not have.
  it.each([
    ['Apple', APPLE, '⌘'],
    ['everywhere else', PC, 'Ctrl']
  ] as ReadonlyArray<readonly [string, PlatformModifier, string]>)(
    'spells them the way %s does',
    (_where, modifier, glyph) => {
      render(<HelpView modifier={modifier} />)
      for (const shortcut of BOUND) {
        const chord = formatChord(shortcut.chord as Chord, modifier)
        // ⌃Tab is Control on every platform.
        const lead = shortcut.chord?.ctrl ? modifier.controlLabel : glyph
        expect(chord.startsWith(lead), `${shortcut.command} is written ${chord}`).toBe(true)
        expect(screen.getByText(chord).tagName).toBe('KBD')
      }
    }
  )
})

describe('what a worktree is', () => {
  it('answers the question the rest of the window assumes you know', () => {
    render(<HelpView modifier={APPLE} />)
    expect(screen.getByRole('heading', { name: 'What a worktree is' })).toBeDefined()
    expect(screen.getByText(/second working directory/)).toBeDefined()
    expect(screen.getByText(/closes its panes/)).toBeDefined()
  })
})

describe('the teamree command', () => {
  it('asks the runtime where the CLI is on arrival', () => {
    render(<HelpView modifier={APPLE} />)
    expect(loadCli).toHaveBeenCalled()
  })

  it('says what to type once the command is on PATH', () => {
    render(<HelpView modifier={APPLE} />)
    expect(screen.getByText(/teamree help/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
  })

  it('sends you to settings instead when it is not', () => {
    seed(status({ state: 'absent' }))
    render(<HelpView modifier={APPLE} />)
    expect(screen.getByText('Not on your PATH')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(toggleSettings).toHaveBeenCalled()
  })

  it('offers the documents in the reader’s own browser', () => {
    render(<HelpView modifier={APPLE} />)
    const readme = screen.getByRole('link', { name: 'README' })
    expect(readme.getAttribute('href')).toBe('https://github.com/zero-abd/teamree/blob/main/README.md')
    expect(readme.getAttribute('target')).toBe('_blank')
    expect(readme.getAttribute('rel')).toBe('noreferrer')
    expect(screen.getByRole('link', { name: 'docs/teamwork.md' }).getAttribute('href')).toBe(
      'https://github.com/zero-abd/teamree/blob/main/docs/teamwork.md'
    )
  })
})

describe('leaving', () => {
  it('closes on the button', () => {
    render(<HelpView modifier={APPLE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the panes' }))
    expect(toggleHelp).toHaveBeenCalled()
  })

  it('closes on Escape, which is what a reader tries first', () => {
    render(<HelpView modifier={APPLE} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleHelp).toHaveBeenCalled()
  })

  // One press, one thing taken away. A palette opened over this page is what
  // Escape is being pressed at, and closing the page underneath it as well
  // would leave somebody back at their panes wondering what they did.
  it('stands aside while a dialog is open', () => {
    useWorkspaceStore.setState({ dialog: { kind: 'palette' } })
    render(<HelpView modifier={APPLE} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleHelp).not.toHaveBeenCalled()
  })

  // The half of "something modal is on screen" that lives outside `dialog`: a
  // question about a teammate's keystrokes, raised by their machine, which
  // cannot be dismissed. Closing this page underneath it leaves the reader
  // behind a scrim with nothing to go back to.
  it('stands aside for a question nobody in this window opened', () => {
    useWorkspaceStore.setState({ consent: { p1: asking } })
    render(<HelpView modifier={APPLE} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggleHelp).not.toHaveBeenCalled()
  })
})

/** A CLI status that is ordinary in every way except what a test names. */
function status(patch: Partial<CliStatus> = {}): CliStatus {
  return {
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    packaged: true,
    bundle: '/Applications/teamree.app/Contents/Resources/cli/index.js',
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'absent',
    resolved: null,
    dangling: false,
    needsAdministrator: true,
    onPath: 'login',
    askedAt: null,
    readAt: 0,
    ...patch
  }
}

/**
 * A teammate's held keystrokes, waiting on this machine's owner to answer.
 *
 * Not in `dialog`: nobody in this window opened it, and it is the one modal
 * here that refuses to be dismissed. See `dialogs/modalLayer.ts`.
 */
const asking: PaneConsent = {
  projectId: 'p1',
  requests: [
    {
      id: 'c1',
      projectId: 'p1',
      terminalId: 't1',
      handle: 'sam',
      publicKey: 'k',
      since: 1,
      at: 2,
      expiresAt: Number.MAX_SAFE_INTEGER,
      writes: 3,
      bytes: 9,
      preview: 'rm -rf .',
      clipped: false
    }
  ],
  standing: [],
  readAt: 2
}
