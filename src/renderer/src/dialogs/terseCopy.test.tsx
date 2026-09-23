/** @vitest-environment jsdom */

// Every dialog, card and page outside Help says a label, a state or an error clause: no subtitle, no
// hint sentence, nothing ending in a full stop. Commands and git's own output (`<pre>`) are exempt.

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatus, ConsentRequest, MemberList, RelaySetting, TeamworkRead, Worktree } from '@shared/entities'

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
const { AddProjectDialog } = await import('./AddProjectDialog')
const { AppearanceDialog } = await import('./AppearanceDialog')
const { TaskComposerDialog } = await import('./TaskComposerDialog')
const { RemoteKeystrokesDialog } = await import('./RemoteKeystrokesDialog')
const { InstallCliDialog } = await import('./InstallCliDialog')
const { FirstRunCliOffer } = await import('./FirstRunCliOffer')
const { ConfirmRemoveDialog } = await import('./ConfirmRemoveDialog')
const { closePaneWarning } = await import('./closePaneModel')
const { cliOutcome } = await import('./cliInstallModel')
const { CommandPalette } = await import('../palette/CommandPalette')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { relayPanel } = await import('../settings/settingsModel')
const { TeamworkSteps } = await import('../teamwork/TeamworkSteps')

const INITIAL = useWorkspaceStore.getState()

/** A full stop after a letter, digit or closing mark, before a gap or the end; a leading list number is not one. */
const SENTENCE_STOP = /(?<!^\d*)[\p{L}\p{N})’”]\.(?=\s|$)/u

/** Every block of visible text under `root` that ends a sentence somewhere, `<pre>` left out. */
function sentenceStops(root: ParentNode): string[] {
  const copy = root.cloneNode(true) as Element
  for (const skipped of copy.querySelectorAll('pre, [aria-hidden="true"]')) skipped.remove()
  const found: string[] = []
  for (const element of [copy, ...copy.querySelectorAll('*')]) {
    const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (own && SENTENCE_STOP.test(text)) found.push(text)
  }
  return found
}

const clauses = (...texts: (string | null | undefined)[]): string[] =>
  texts.filter((text): text is string => typeof text === 'string' && SENTENCE_STOP.test(text))

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }],
      worktrees: [worktree()],
      activeWorktreeId: 'w1',
      agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }],
      agentsProbed: true,
      closeDialog: vi.fn(),
      ...overrides
    },
    true
  )
}

const worktree = (): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
})

const cli = (overrides: Partial<CliStatus> = {}): CliStatus => ({
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
  onPath: null,
  askedAt: null,
  readAt: 0,
  ...overrides
})

const CLI_STATES: Partial<CliStatus>[] = [
  {},
  { installable: false, platform: 'linux' },
  { source: null },
  { impermanent: 'volume' },
  { impermanent: 'translocated' },
  { bundle: null, packaged: false },
  { state: 'linked', resolved: '/Applications/teamree.app/Contents/Resources/cli/teamree', onPath: 'shell' },
  { state: 'file' },
  { state: 'directory' },
  { state: 'elsewhere', resolved: '/Old/teamree', dangling: true },
  { state: 'elsewhere', resolved: '/Old/teamree', dangling: false, needsAdministrator: false }
]

const request = (): ConsentRequest => ({
  id: 'ask_1',
  projectId: 'p1',
  terminalId: 't_7',
  handle: 'priya',
  publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
  since: 1_000,
  at: 1_500,
  expiresAt: Date.now() + 60_000,
  writes: 4,
  bytes: 4,
  preview: 'npm test⏎',
  clipped: true
})

const noRelay = (): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: null,
  source: null,
  problem: 'no .teamree/relay',
  onDisk: { url: null, problem: 'no .teamree/relay' },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  deploy: { command: '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null },
  readAt: 0
})

const onDisk = (): RelaySetting => ({
  ...noRelay(),
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  onDisk: { url: 'wss://relay.example/v1/relay', problem: null }
})

const roster = (enrolled: boolean): MemberList => ({
  projectId: 'p1',
  members: enrolled
    ? [
        {
          handle: 'ada',
          publicKey: 'k'.repeat(44),
          addedAt: '2026-03-01',
          file: '.teamree/members/ada.pub',
          isSelf: true
        }
      ]
    : [],
  problems: [],
  self: { handle: enrolled ? 'ada' : null, publicKey: 'k'.repeat(44) },
  selfFile: enrolled ? '.teamree/members/ada.pub' : null,
  enrolled,
  watched: false,
  readAt: 0
})

const status = (overrides: Partial<TeamworkRead> = {}): TeamworkRead => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true, url: 'https://example.com/ada/pager.git' },
  enrolled: true,
  links: [],
  readAt: 0,
  ...overrides
})

beforeEach(() => seed())
afterEach(() => cleanup())

describe('dialogs', () => {
  it('have a title and no subtitle', () => {
    for (const dialog of [
      <AddProjectDialog key="a" />,
      <AppearanceDialog key="b" />,
      <TaskComposerDialog key="c" projectId="p1" />
    ]) {
      const { container, unmount } = render(dialog)
      expect(container.ownerDocument.querySelector('.modal__head p')).toBeNull()
      unmount()
    }
  })

  it('add project: no sentence in any state', async () => {
    const selectProjectFolder = vi.fn(() => Promise.reject(new Error('no picker')))
    ;(window as unknown as { teamree: unknown }).teamree = { selectProjectFolder }
    seed({ addProject: vi.fn(async () => 'not-a-repository') })
    const view = render(<AddProjectDialog />)
    fireEvent.click(view.getByRole('button', { name: 'Choose folder…' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Repository path' }), { target: { value: '/tmp/x' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Add project' }))
    })
    await vi.waitFor(() => expect(view.getAllByRole('alert').length).toBe(2))
    expect(sentenceStops(document.body)).toEqual([])
  })

  it('appearance: theme cards are a name and a swatch, the colour list has no prose', () => {
    seed({ appearance: { themeId: 'black', ground: null, accent: '#ff00ff', overrides: {} } })
    const view = render(<AppearanceDialog />)
    fireEvent.click(view.getByRole('button', { name: /Every colour/ }))
    for (const card of document.querySelectorAll('.appearance__theme')) {
      expect(card.textContent?.trim()).toMatch(/^[\w ,]+$/)
    }
    expect(sentenceStops(document.body)).toEqual([])
  })

  it('new task: no shortcut hint and no sentence', () => {
    render(<TaskComposerDialog projectId="p1" />)
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'Fix the pager' } })
    expect(document.body.textContent).not.toMatch(/Shift\+Enter/)
    expect(sentenceStops(document.body)).toEqual([])
  })

  it('remote keystrokes: no sentence', () => {
    render(<RemoteKeystrokesDialog request={request()} />)
    expect(sentenceStops(document.body)).toEqual([])
  })

  it('install CLI and the first-run card: no sentence in any state', () => {
    for (const overrides of CLI_STATES) {
      seed({ cli: cli(overrides), loadCli: vi.fn() })
      const view = render(
        <>
          <InstallCliDialog />
          <FirstRunCliOffer />
        </>
      )
      expect(sentenceStops(document.body), JSON.stringify(overrides)).toEqual([])
      view.unmount()
    }
    for (const outcome of ['linked', 'replaced', 'already-linked'] as const) {
      const text = cliOutcome({
        outcome,
        replaced: '/Old/teamree',
        administrator: true,
        status: cli({ onPath: 'environment' })
      })
      expect(clauses(text)).toEqual([])
    }
  })

  it('discarding a worktree and closing a busy pane: no sentence', () => {
    seed({
      statuses: {
        w1: { worktreeId: 'w1', branch: 'b', staged: 1, unstaged: 2, untracked: 0, conflicted: 0, ignored: 3 }
      }
    })
    render(<ConfirmRemoveDialog worktreeId="w1" reason="uncommitted work in rewrite" />)
    expect(sentenceStops(document.body)).toEqual([])
    const terminal = { id: 't1', title: 'zsh', running: true, busy: true } as never
    const agent = { id: 't2', title: 'claude', running: true, busy: false, agent: 'claude' } as never
    expect(clauses(closePaneWarning(terminal)?.body, closePaneWarning(agent)?.body)).toEqual([])
  })
})

describe('the palette', () => {
  it('drops the Action and pane descriptors and keeps the chord', () => {
    render(<CommandPalette modifier={resolvePlatformModifier('darwin')} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bAction\b/)
    expect(text).not.toMatch(/Opens a pane here/)
    expect(document.querySelectorAll('.palette__hint').length).toBeGreaterThan(0)
  })
})

describe('the settings relay row', () => {
  it('is one clause in every state', () => {
    const states: (RelaySetting | undefined)[] = [
      undefined,
      noRelay(),
      onDisk(),
      { ...onDisk(), source: 'environment', override: { name: 'TEAMREE_RELAY_URL', value: 'wss://other/v1/relay' } }
    ]
    for (const relay of states) {
      const panel = relayPanel(relay)
      expect(clauses(panel.headline, panel.detail, panel.override)).toEqual([])
    }
  })
})

describe('the teamwork page', () => {
  const props = {
    projectPath: '/repos/pager',
    membersPending: false,
    membersError: null,
    relayPending: false,
    relayError: null,
    readErrors: {},
    onJoin: () => {},
    onClearMembersError: () => {},
    onSetRelay: () => {},
    onRetry: () => {},
    origin: { pending: false, error: null },
    onSetOrigin: () => {},
    pane: undefined,
    onStartRelayPane: () => {},
    onClosePane: () => {},
    renderRelayPane: () => null,
    publish: { plan: undefined, pending: false, error: null, result: undefined, progress: undefined },
    onPublish: () => {},
    onCancelPublish: () => {},
    onChoosePath: () => {},
    projectName: 'pager',
    onCopy: () => {}
  }

  it('says no sentence from the first step to the outcome', () => {
    const cases = [
      { list: roster(false), relay: noRelay(), status: status({ enrolled: false }), path: 'start' as const },
      { list: roster(false), relay: noRelay(), status: status(), path: 'join' as const },
      { list: roster(true), relay: onDisk(), status: status(), path: 'start' as const },
      {
        list: roster(true),
        relay: onDisk(),
        status: status({ origin: { ok: false, reason: 'no origin remote' } }),
        path: 'start' as const
      },
      { list: roster(true), relay: onDisk(), status: status(), path: null }
    ]
    for (const input of cases) {
      const host = document.createElement('div')
      host.innerHTML = renderToStaticMarkup(<TeamworkSteps {...props} {...input} />)
      expect(sentenceStops(host), JSON.stringify(input.path)).toEqual([])
    }
  })
})
