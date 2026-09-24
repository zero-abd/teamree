/** @vitest-environment jsdom */

// Every dialog, card and page outside Help says a label, a state or an error clause: no subtitle, no
// hint sentence, nothing ending in a full stop. Commands and git's own output (`<pre>`) are exempt.
// Buttons and titles are Title Case, as the menus are; body text stays sentence case.

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
const { CloneProjectDialog } = await import('./CloneProjectDialog')
const { ProjectRefusedDialog } = await import('./ProjectRefusedDialog')
const { AppearanceSettings } = await import('../settings/AppearanceSettings')
const { TaskComposerDialog } = await import('./TaskComposerDialog')
const { RemoteKeystrokesDialog } = await import('./RemoteKeystrokesDialog')
const { InstallCliDialog } = await import('./InstallCliDialog')
const { FirstRunCliOffer } = await import('./FirstRunCliOffer')
const { ConfirmRemoveDialog } = await import('./ConfirmRemoveDialog')
const { ConfirmDiscardDialog } = await import('./ConfirmDiscardDialog')
const { ConfirmCloseFileDialog } = await import('./ConfirmCloseFileDialog')
const { ConfirmUnsavedDialog } = await import('./ConfirmUnsavedDialog')
const { closePaneWarning } = await import('./closePaneModel')
const { cliOutcome } = await import('./cliInstallModel')
const { CommandPalette } = await import('../palette/CommandPalette')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { relayPanel } = await import('../settings/settingsModel')
const { TeamworkSteps } = await import('../teamwork/TeamworkSteps')
const { checkOriginDraft, checkRelayDraft } = await import('../teamwork/startTeamwork')
const { muteTitle } = await import('../terminal/TerminalView')
const { ChangesTab, pushFailedText } = await import('../workspace/rightPanel/ChangesTab')
const { runtimeClient } = await import('../runtimeClient/currentRuntimeClient')
const { pushFailureLabel } = await import('../../../main/git/worktreePush')
const { ConfirmClosePaneDialog } = await import('./ConfirmClosePaneDialog')
const { Welcome } = await import('../workspace/Welcome')
const { HelpView } = await import('../help/HelpView')
const { SettingsView } = await import('../settings/SettingsView')
const { Dashboard } = await import('../dashboard/Dashboard')

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

/** An unsaved-changes question's lines between the title and the file list, and its buttons. */
function unsavedAnswers(): { lines: string[]; buttons: string[]; focused: string } {
  const dialog = document.querySelector('[role="dialog"]')
  return {
    lines: [...(dialog?.querySelectorAll('.confirm__body') ?? [])].map((line) => line.textContent ?? ''),
    buttons: [...(dialog?.querySelectorAll('.modal__actions .button') ?? [])].map((button) => button.textContent ?? ''),
    focused: document.activeElement?.textContent ?? ''
  }
}

/** Lower case inside a Title Case label: articles, conjunctions and prepositions under four letters. */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'nor',
  'for',
  'as',
  'at',
  'by',
  'in',
  'of',
  'on',
  'to',
  'vs'
])

/** A word Title Case leaves alone: a path, URL, command, number or the lower-case brand. */
const verbatim = (word: string): boolean => !/^\p{L}/u.test(word) || /[\d/:@_=~]|\.\w/.test(word) || word === 'teamree'

function titleCased(label: string): boolean {
  const words = label.split(' ').map((word) => word.replace(/^[“"‘(]+|[”"’),.…]+$/g, ''))
  return words.every((word, index) => {
    if (word === '' || verbatim(word)) return true
    const inner = index > 0 && index < words.length - 1
    return /^\p{Lu}/u.test(word) || (inner && MINOR_WORDS.has(word))
  })
}

/**
 * Every button, tab and dialog or page title under `root` that is not Title Case; a question title is a
 * sentence, and a theme card is the theme's name.
 */
function casingFaults(root: ParentNode): string[] {
  const found: string[] = []
  for (const element of root.querySelectorAll('button, [role="tab"], .modal__title, .page__title')) {
    if (element.matches('.appearance__theme')) continue
    const copy = element.cloneNode(true) as Element
    for (const skipped of copy.querySelectorAll('[aria-hidden="true"], kbd, code, svg')) skipped.remove()
    const label = (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (label === '' || (element.matches('.modal__title') && label.endsWith('?'))) continue
    if (!titleCased(label)) found.push(label)
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
      <CloneProjectDialog key="a" />,
      <ProjectRefusedDialog key="b" folder="/tmp/x" refusal="not-a-repository" />,
      <TaskComposerDialog key="c" projectId="p1" />
    ]) {
      const { container, unmount } = render(dialog)
      expect(container.ownerDocument.querySelector('.modal__head p')).toBeNull()
      unmount()
    }
  })

  it('add project: no sentence in any state', async () => {
    seed({ cloneProject: vi.fn(async () => 'Repository not found') })
    const refused = render(<ProjectRefusedDialog folder="/tmp/x" refusal="not-a-repository" />)
    expect(sentenceStops(document.body)).toEqual([])
    refused.unmount()

    const view = render(<CloneProjectDialog />)
    fireEvent.change(view.getByRole('textbox', { name: 'Repository URL' }), { target: { value: '/srv/x.git' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Clone' }))
    })
    expect(view.getByRole('alert').textContent).toBe('Repository not found')
    expect(sentenceStops(document.body)).toEqual([])
  })

  it('appearance: theme cards are a name and a swatch, the colour list has no prose', () => {
    seed({ appearance: { themeId: 'black', ground: null, accent: '#ff00ff', overrides: {} } })
    const view = render(<AppearanceSettings />)
    fireEvent.click(view.getByRole('button', { name: 'All Colours' }))
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

  it('removing a worktree and closing a busy pane: no sentence', () => {
    seed({
      statuses: {
        w1: { worktreeId: 'w1', branch: 'b', staged: 1, unstaged: 2, untracked: 0, conflicted: 0, ignored: 3 }
      }
    })
    render(<ConfirmRemoveDialog worktreeId="w1" />)
    expect(sentenceStops(document.body)).toEqual([])
    expect(document.body.textContent).not.toMatch(/force|uncommitted changes/)
    const terminal = { id: 't1', title: 'zsh', running: true, busy: true } as never
    const agent = { id: 't2', title: 'claude', running: true, busy: false, agent: 'claude' } as never
    expect(clauses(closePaneWarning(terminal)?.body, closePaneWarning(agent)?.body)).toEqual([])
  })

  it('saving a file before closing it: no sentence', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: {
        w1: {
          worktreeId: 'w1',
          root: { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'src/app.ts' },
          focusedTerminalId: 'file:1'
        }
      }
    })
    render(<ConfirmCloseFileDialog terminalId="file:1" />)
    expect(document.body.textContent).toContain('Save changes to')
    expect(sentenceStops(document.body)).toEqual([])
    expect(unsavedAnswers()).toEqual({ lines: [], buttons: ["Don't Save", 'Cancel', 'Save'], focused: 'Save' })
  })

  it('saving before a quit, a close or a removal: no sentence, the same three answers', () => {
    seed({
      editedFiles: {
        'file:1': { worktreeId: 'w1', path: 'src/math.ts' },
        'file:2': { worktreeId: 'w1', path: 'src/app.ts' }
      }
    })
    const one = render(<ConfirmUnsavedDialog paneIds={['file:1']} />)
    expect(document.body.textContent).toContain('src/math.ts')
    expect(sentenceStops(document.body)).toEqual([])
    expect(unsavedAnswers()).toEqual({ lines: [], buttons: ["Don't Save", 'Cancel', 'Save'], focused: 'Save' })
    one.unmount()
    render(<ConfirmUnsavedDialog paneIds={['file:1', 'file:2']} />)
    expect(document.body.textContent).toContain('src/app.ts')
    expect(unsavedAnswers()).toEqual({ lines: [], buttons: ["Don't Save", 'Cancel', 'Save All'], focused: 'Save All' })
  })

  it('discarding a file or a hunk from the Changes tab: no sentence', () => {
    seed({
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [{ path: 'src/new.ts', kind: 'untracked', staged: false, unstaged: true }],
          total: 1,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
    const hunk = { header: '@@ -1,1 +1,1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }
    for (const props of [{ path: 'src/app.ts' }, { path: 'src/new.ts' }, { path: 'src/app.ts', hunk }]) {
      const { unmount } = render(<ConfirmDiscardDialog worktreeId="w1" {...props} />)
      expect(document.body.textContent).toContain('src/')
      expect(sentenceStops(document.body)).toEqual([])
      unmount()
    }
  })
})

describe('the palette', () => {
  it('drops the Action and pane descriptors and keeps the chord', () => {
    render(<CommandPalette modifier={resolvePlatformModifier('darwin')} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bAction\b/)
    expect(text).not.toMatch(/Opens a pane here/)
    expect(document.querySelectorAll('.palette__trailing').length).toBeGreaterThan(0)
    expect(document.querySelector('.modal__title')).toBeNull()
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

describe('the pane mute button', () => {
  it('names the state or the action', () => {
    expect([muteTitle(true), muteTitle(false)]).toEqual(['Muted for teammates', 'Mute for teammates'])
  })
})

/** One line: no sentence stop, at most one ` · ` join, and short enough to read at a glance. */
function oneLine(reason: string): boolean {
  return !SENTENCE_STOP.test(reason) && reason.split(' · ').length <= 2 && reason.length <= 90
}

describe('pushing from the Changes tab', () => {
  const refusals = [
    "fatal: '/tmp/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
    'fatal: Authentication failed for https://example.invalid/x.git',
    "fatal: could not read Username for 'https://x': terminal prompts disabled",
    ' ! [rejected]   main -> main (fetch first)\nhint: Updates were rejected because the remote contains work',
    ' ! [remote rejected] main -> main (pre-receive hook declined)',
    "fatal: unable to access 'https://x/': Could not resolve host: x",
    'Host key verification failed.',
    'fatal: the remote end hung up unexpectedly',
    ''
  ]

  it('says a failure in one clause, git’s words kept out of the text', () => {
    for (const stderr of refusals) {
      const label = pushFailureLabel(stderr)
      expect(oneLine(label) && !label.includes(' · ') && label.split(' ').length <= 4, `${stderr}: ${label}`).toBe(true)

      seed({ statuses: { w1: pushStatus() }, pushes: { w1: { phase: 'failed', error: label, detail: stderr } } })
      const { unmount } = render(<ChangesTab />)
      expect(document.querySelector('[role=alert]')?.textContent).toBe(pushFailedText(label))
      expect(sentenceStops(document.body)).toEqual([])
      unmount()
    }
  })

  it('toasts one word when the push lands out of sight', async () => {
    for (const alreadyUpToDate of [false, true]) {
      seed({ statuses: { w1: pushStatus() }, rightPanelOpen: false })
      const call = vi.spyOn(runtimeClient, 'call').mockResolvedValueOnce({
        worktreeId: 'w1',
        remote: 'origin',
        branch: 'rewrite-the-pager',
        alreadyUpToDate,
        upstream: 'origin/rewrite-the-pager',
        setUpstream: true,
        uncommitted: 3,
        pushedAt: 0
      } as never)
      await useWorkspaceStore.getState().pushActiveWorktree()
      expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toEqual([
        alreadyUpToDate ? 'Up to date' : 'Pushed'
      ])
      call.mockRestore()
    }
  })
})

const pushStatus = () => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  upstream: 'origin/rewrite-the-pager',
  ahead: 1,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0
})

describe('typed-URL validation', () => {
  it('refuses every bad origin in one line', () => {
    const origins = [
      'pager',
      'https://example.com/a repo',
      'ext::sh -c id',
      'svn://example.com/repo',
      'file:%zz',
      'file://fileserver/team/app.git',
      'file:///Volumes/team/app%E0%A4%A.git',
      '/Volumes/team/app\n.git',
      '~/shared/app.git',
      '../pager',
      '/Volumes/team/../team/pager.git',
      '/'
    ]
    for (const origin of origins) {
      const checked = checkOriginDraft(origin)
      expect(checked.state, origin).toBe('bad')
      if (checked.state === 'bad') expect(oneLine(checked.reason), `${origin}: ${checked.reason}`).toBe(true)
    }
    const path = checkOriginDraft('/Volumes/team/app.git')
    expect(path.state === 'ok' && path.note !== null && oneLine(path.note)).toBe(true)
  })

  it('refuses every bad relay URL in one line', () => {
    const relays = [
      'not a url',
      'https://teamree-relay.example.workers.dev',
      'http://127.0.0.1:8787/v1/relay',
      'ftp://relay.example/v1/relay',
      'wss://relay.example/v1/relay?token=abc',
      'wss://my-relay.example.workers.dev'
    ]
    for (const relay of relays) {
      const checked = checkRelayDraft(relay)
      expect(checked.state, relay).toBe('bad')
      if (checked.state === 'bad') expect(oneLine(checked.reason), `${relay}: ${checked.reason}`).toBe(true)
    }
  })

  it('says the fix and what was typed instead', () => {
    expect(checkRelayDraft('https://relay.example/v1/relay')).toMatchObject({
      reason: 'Use wss://relay.example/v1/relay, not https://'
    })
    expect(checkRelayDraft('ftp://relay.example/v1/relay')).toMatchObject({ reason: 'Use ws:// or wss://, not ftp://' })
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

  it('opens on two buttons and no question', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      <TeamworkSteps
        {...props}
        list={roster(false)}
        relay={noRelay()}
        status={status({ enrolled: false })}
        path={null}
      />
    )
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Start a Team', 'Join…'])
    expect(host.textContent).not.toContain('?')
    expect(sentenceStops(host)).toEqual([])
  })

  it('says no sentence under the origin field, refused or accepted', () => {
    const blocked = status({ origin: { ok: false, reason: 'no origin remote' } })
    const view = render(<TeamworkSteps {...props} list={roster(true)} relay={onDisk()} status={blocked} path="start" />)
    const field = view.getByRole('textbox', { name: 'Origin' })
    for (const draft of ['~/shared/pager.git', '/Volumes/team/pager.git']) {
      fireEvent.change(field, { target: { value: draft } })
      expect(sentenceStops(document.body), draft).toEqual([])
    }
  })
})

describe('buttons and titles', () => {
  it('know Title Case from sentence case', () => {
    for (const label of [
      'Open Folder…',
      'Check for Updates',
      'Start a Team',
      'Use wss://relay/v1',
      'Put teamree on PATH'
    ])
      expect(titleCased(label), label).toBe(true)
    for (const label of ['New task', 'Check for updates', 'Add my key', 'Not that'])
      expect(titleCased(label), label).toBe(false)
  })

  it('are Title Case in every dialog', async () => {
    seed({
      cloneProject: vi.fn(async () => 'Repository not found'),
      agents: [
        { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
        { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
      ],
      terminals: { t2: { id: 't2', title: 'claude', running: true, busy: true, agent: 'claude' } },
      statuses: {
        w1: { worktreeId: 'w1', branch: 'b', staged: 1, unstaged: 2, untracked: 0, conflicted: 0, ignored: 3 }
      },
      editedFiles: { 'file:1': { worktreeId: 'w1', path: 'src/math.ts' } },
      cli: cli()
    })
    const dialogs = [
      <CloneProjectDialog key="clone" />,
      <ProjectRefusedDialog key="refused" folder="/tmp/x" refusal="not-a-repository" />,
      <TaskComposerDialog key="task" projectId="p1" />,
      <InstallCliDialog key="cli" />,
      <FirstRunCliOffer key="offer" />,
      <ConfirmRemoveDialog key="remove" worktreeId="w1" />,
      <ConfirmDiscardDialog key="discard" worktreeId="w1" path="src/app.ts" />,
      <ConfirmCloseFileDialog key="file" terminalId="file:1" />,
      <ConfirmUnsavedDialog key="unsaved" paneIds={['file:1']} />,
      <ConfirmClosePaneDialog key="pane" terminalId="t2" />
    ]
    for (const dialog of dialogs) {
      const view = render(dialog)
      expect(casingFaults(document.body), String(dialog.key)).toEqual([])
      view.unmount()
    }
    for (const overrides of CLI_STATES) {
      seed({ cli: cli(overrides), loadCli: vi.fn() })
      const view = render(<InstallCliDialog />)
      expect(casingFaults(document.body), JSON.stringify(overrides)).toEqual([])
      view.unmount()
    }
  })

  // Commands and agents; a worktree or file row is somebody's name for it.
  it('are Title Case in the palette, every command it offers with nothing typed', () => {
    seed({ worktrees: [worktree()], activeWorktreeId: 'w1', cli: cli() })
    render(<CommandPalette modifier={resolvePlatformModifier('darwin')} />)
    const labels = [...document.querySelectorAll('[role="option"]:is([data-kind="action"], [data-kind="agent"])')].map(
      // A theme row ends in the theme's own name, as its card does.
      (row) => (row.querySelector('.palette__label')?.textContent ?? '').replace(/^(Theme): .*/, '$1')
    )
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.filter((label) => label !== '' && !titleCased(label))).toEqual([])
  })

  it('are Title Case where somebody else’s keystrokes are asked about, the title naming who', () => {
    render(<RemoteKeystrokesDialog request={request()} />)
    expect(casingFaults(document.body)).toEqual(['priya wants to type in t_7'])
  })

  it('are Title Case on the welcome, in Help, Appearance and Settings, and on the Changes tab', () => {
    for (const project of [undefined, { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }]) {
      const view = render(<Welcome modifier={resolvePlatformModifier('darwin')} project={project} />)
      expect(casingFaults(document.body)).toEqual([])
      view.unmount()
    }
    for (const state of ['absent', 'linked'] as const) {
      seed({ cli: cli({ state }), loadCli: vi.fn() })
      const view = render(<HelpView modifier={resolvePlatformModifier('darwin')} />)
      expect(casingFaults(document.body), state).toEqual([])
      view.unmount()
    }
    seed({ appearance: { themeId: 'black', ground: null, accent: null, overrides: {} } })
    const appearance = render(<AppearanceSettings />)
    fireEvent.click(appearance.getByRole('button', { name: 'All Colours' }))
    expect(casingFaults(document.body)).toEqual([])
    appearance.unmount()
    seed({ statuses: { w1: { ...pushStatus(), upstream: null } } })
    const changes = render(<ChangesTab />)
    expect(casingFaults(document.body)).toEqual([])
    changes.unmount()
    seed({
      settingsOpen: true,
      relays: { p1: noRelay() },
      cli: cli(),
      update: {
        current: '1.4.0',
        checkable: true,
        automatic: true,
        available: null,
        checking: false,
        checkedAt: null,
        problem: null
      },
      loadCli: vi.fn(),
      loadUpdate: vi.fn(),
      loadRelay: vi.fn()
    })
    render(<SettingsView />)
    expect(casingFaults(document.body)).toEqual([])
  })

  it('are Title Case on All Panes, its title the one the sidebar names', () => {
    render(<Dashboard />)
    expect(document.querySelector('.page__title')?.textContent).toBe('All Panes')
    expect(casingFaults(document.body)).toEqual([])
  })

  it('are Title Case in the Add My Key question, its body the one line of what a key grants', () => {
    const view = render(
      <TeamworkSteps
        projectPath="/repos/pager"
        list={roster(false)}
        relay={noRelay()}
        status={status({ enrolled: false })}
        membersPending={false}
        membersError={null}
        relayPending={false}
        relayError={null}
        readErrors={{}}
        onJoin={() => {}}
        onClearMembersError={() => {}}
        onSetRelay={() => {}}
        onRetry={() => {}}
        origin={{ pending: false, error: null }}
        onSetOrigin={() => {}}
        pane={undefined}
        onStartRelayPane={() => {}}
        onClosePane={() => {}}
        renderRelayPane={() => null}
        publish={{ plan: undefined, pending: false, error: null, result: undefined, progress: undefined }}
        onPublish={() => {}}
        onCancelPublish={() => {}}
        path="start"
        onChoosePath={() => {}}
        projectName="pager"
        onCopy={() => {}}
      />
    )
    expect(document.querySelector('.grant')).toBeNull()
    fireEvent.change(view.getByRole('textbox', { name: /^Handle/ }), { target: { value: 'ada' } })
    fireEvent.click(view.getByRole('button', { name: 'Add My Key' }))
    const dialog = view.getByRole('dialog')
    expect(casingFaults(dialog)).toEqual([])
    expect(sentenceStops(dialog)).toEqual([])
  })

  it('are Title Case on the teamwork page, every step opened', () => {
    const props = {
      projectPath: '/repos/pager',
      membersPending: false,
      membersError: null,
      relayPending: false,
      relayError: null,
      readErrors: { status: 'timed out' },
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
    const cases = [
      { list: roster(false), relay: noRelay(), status: undefined, path: null },
      { list: roster(false), relay: noRelay(), status: undefined, path: 'start' as const },
      {
        list: roster(true),
        relay: noRelay(),
        status: status({ origin: { ok: false, reason: 'no origin' } }),
        path: 'start' as const
      },
      { list: roster(true), relay: onDisk(), status: status(), path: 'join' as const }
    ]
    for (const input of cases) {
      const view = render(<TeamworkSteps {...props} {...input} />)
      for (const step of view.container.querySelectorAll<HTMLButtonElement>('.step__toggle')) {
        fireEvent.click(step)
        for (const more of view.queryAllByRole('button', { name: /^(More|Paste URL…)$/ })) fireEvent.click(more)
        expect(casingFaults(document.body), `${input.path} ${step.textContent}`).toEqual([])
      }
      expect(casingFaults(document.body), String(input.path)).toEqual([])
      view.unmount()
    }
  })
})
