// A stand-in runtime that answers the whole method catalogue from memory, so
// the interface is demonstrable — splits, background worktree creation,
// failures, live terminal output — before the real transport exists. It is
// deliberately the only place in the renderer that fabricates data.

import type {
  CliStatus,
  ConsentGrant,
  ConsentRequest,
  Layout,
  Member,
  MemberList,
  PaneNode,
  Project,
  RelaySetting,
  RemoteWrite,
  StartPoint,
  StartPointList,
  Terminal,
  UpdateState,
  Worktree,
  WorktreeChange,
  WorktreeStatus
} from '@shared/entities'
import type { MethodName, ParamsOf, ResultOf, TerminalEvent, WorkspaceEvent } from '@shared/methods'
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from '@shared/theme'
import { leaf, splitPane } from '../panes/paneLayout'
import type { ConnectionState, RuntimeClient, Subscription } from './RuntimeClientContract'

const CREATE_MS = 2600
const LATENCY_MS = 45

let counter = 0
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(4, '0')}`

const sgr = (code: string, text: string): string => `\u001b[${code}m${text}\u001b[0m`
const dim = (text: string): string => sgr('38;5;244', text)
const accent = (text: string): string => sgr('38;5;147', text)
const good = (text: string): string => sgr('38;5;114', text)
const warn = (text: string): string => sgr('38;5;179', text)

type FakeTerminal = {
  record: Terminal
  buffer: string
  line: string
  listeners: Set<(event: TerminalEvent) => void>
}

/**
 * Paths the seeded changes are drawn from, cycled so the same worktree always
 * shows the same files. Invented, but invented once.
 */
const SEEDED_PATHS = [
  'src/search/rankResults.ts',
  'src/search/index.ts',
  'src/search/rankResults.test.ts',
  'src/shell/StatusBar.tsx',
  'src/styles/tokens.css',
  'docs/search.md',
  'scripts/reindex.mjs',
  'src/server/handlers.ts'
]

/** The demo's own identity. Invented, like everything else in this file. */
const SEEDED_HANDLE = 'you'
/** Two invented teammates: one connected, one whose machine is not. */
const SEEDED_PEER_KEY = 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM='
const SEEDED_AWAY_KEY = 'Qw8ErTyUiOpAsDfGhJkLzXcVbNm1234567890QwErTy='
const SEEDED_PUBLIC_KEY = 'EA3VNMgROVtL/oUJhTmpENptwwkAWhc1HD2SIqJTHE4='

/**
 * The teammate panes this demo can open, and the scrollback each joins at.
 *
 * A watcher joining a running pane is shown what it has already said and then
 * whatever it says next. With no relay and no teammate there is no "next", so
 * these are the first half only — which is the honest half to invent.
 */
const SEEDED_WATCHABLE: Record<string, { handle: string; cols: number; rows: number; scrollback: string }> = {
  [`peer:${SEEDED_PEER_KEY.slice(0, 12)}:t_remote_1`]: {
    handle: 'priya',
    cols: 96,
    rows: 30,
    scrollback:
      'priya@studio compaction % claude\r\n' +
      '\u001b[38;5;244m· reading src/index/segment.rs\u001b[0m\r\n' +
      '\u001b[38;5;244m· 412 lines, 3 merge candidates\u001b[0m\r\n' +
      'compacting segments 0..7\r\n'
  },
  [`peer:${SEEDED_PEER_KEY.slice(0, 12)}:t_remote_2`]: {
    handle: 'priya',
    cols: 120,
    rows: 40,
    scrollback: 'priya@studio compaction % pytest -q\r\n............................\r\n28 passed in 4.11s\r\n'
  }
}

function seededMember(handle: string, publicKey: string, addedAt: string): Member {
  return { handle, publicKey, addedAt, file: `.teamree/members/${handle}.pub`, isSelf: false }
}

/**
 * Changed paths made up to match a worktree's counters, so the list and the
 * chips above it never contradict each other in the demo.
 */
function seededChanges(status: WorktreeStatus): WorktreeChange[] {
  const changes: WorktreeChange[] = []
  let next = 0
  const take = (): string => SEEDED_PATHS[next++ % SEEDED_PATHS.length] as string

  for (let index = 0; index < status.conflicted; index += 1) {
    changes.push({ path: take(), kind: 'conflicted', staged: false, unstaged: true })
  }
  for (let index = 0; index < status.staged; index += 1) {
    changes.push({
      path: take(),
      kind: index === 0 ? 'added' : 'modified',
      staged: true,
      unstaged: false
    })
  }
  for (let index = 0; index < status.unstaged; index += 1) {
    changes.push({ path: take(), kind: 'modified', staged: false, unstaged: true })
  }
  for (let index = 0; index < status.untracked; index += 1) {
    changes.push({ path: take(), kind: 'untracked', staged: false, unstaged: true })
  }
  return changes
}

/** A small believable patch, so the diff pane has something to render. */
function seededPatch(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 3f8a1c2..9b21e40 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -14,7 +14,9 @@',
    ' export function rankResults(hits: Hit[], query: Query): Hit[] {',
    '-  return hits.sort((left, right) => right.score - left.score)',
    '+  const weighted = hits.map((hit) => ({ ...hit, score: hit.score * recency(hit) }))',
    '+  // Ties went to whichever the index happened to return first, which is',
    '+  // not stable between runs.',
    '+  return weighted.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))',
    ' }',
    ''
  ].join('\n')
}

export function createSeededRuntimeClient(): RuntimeClient {
  const projects = new Map<string, Project>()
  const worktrees = new Map<string, Worktree>()
  const statuses = new Map<string, WorktreeStatus>()
  const terminals = new Map<string, FakeTerminal>()
  const layouts = new Map<string, Layout>()
  /** Rosters by project id, so joining one in the demo really does add a row. */
  const rosters = new Map<string, Member[]>()
  /** The relay each project meets on, so setting one in the demo takes effect. */
  const relays = new Map<string, string>()
  /** Panes muted in the demo. A mute is local, so this one is not a pretence. */
  const seededMutes = new Set<string>()
  /** One remote write, so the record's shape is visible without a teammate. */
  const seededWrites: RemoteWrite[] = []
  /**
   * Standing permissions given in the demo. Local like a mute, so this one is
   * not a pretence either: granting one here really does remove the row.
   */
  const seededGrants = new Map<string, ConsentGrant>()
  /**
   * One teammate's keystrokes, held at a pane of this machine.
   *
   * Seeded because the prompt is the part of teamwork a demo cannot otherwise
   * show — it needs a teammate on the far end of a relay to happen at all — and
   * because what it puts on screen is bytes somebody else chose. The preview
   * carries a carriage return and an escape sequence rendered as the runtime
   * renders them, so the demo shows the safe form rather than a tidy sentence
   * that would never occur.
   */
  const seededRequests: ConsentRequest[] = []

  let connection: ConnectionState = { phase: 'connecting', detail: 'Starting runtime' }
  const connectionListeners = new Set<(state: ConnectionState) => void>()

  // The demo announces its own changes exactly as the real runtime does, so the
  // browser path exercises the same subscribe-and-refetch code rather than a
  // second, quieter one that could rot unnoticed. Delivery is deferred by a
  // turn because a handler is still mid-call when it announces: the caller must
  // have its result before a refetch goes looking for what it changed.
  const workspaceWatchers = new Set<(event: WorkspaceEvent) => void>()
  const announce = (...events: WorkspaceEvent[]): void => {
    setTimeout(() => {
      for (const event of events) {
        for (const watcher of [...workspaceWatchers]) watcher(event)
      }
    }, 0)
  }

  const setConnection = (state: ConnectionState): void => {
    connection = state
    for (const listener of connectionListeners) listener(state)
  }

  // The real client flips to ready once the handshake lands; mirror that shape
  // so the status bar has the same states to animate through.
  setTimeout(() => setConnection({ phase: 'ready' }), 420)

  const emit = (terminal: FakeTerminal, event: TerminalEvent): void => {
    if (event.type === 'data') terminal.buffer = (terminal.buffer + event.data).slice(-64000)
    for (const listener of terminal.listeners) listener(event)
  }

  const prompt = (terminal: FakeTerminal): string => {
    const worktree = worktrees.get(terminal.record.worktreeId)
    return `${accent(worktree?.branch ?? 'teamree')} ${dim('❯')} `
  }

  const spawn = (worktreeId: string, title: string, banner: string[]): Terminal => {
    const worktree = worktrees.get(worktreeId)
    const record: Terminal = {
      id: nextId('term'),
      worktreeId,
      title,
      cwd: worktree?.path ?? '~',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      busy: false,
      lastOutputAt: Date.now(),
      running: true
    }
    const terminal: FakeTerminal = { record, buffer: '', line: '', listeners: new Set() }
    terminals.set(record.id, terminal)
    terminal.buffer = `${banner.join('\r\n')}\r\n${prompt(terminal)}`
    return record
  }

  const seedProject = (name: string, path: string, baseRef: string): Project => {
    const project: Project = { id: nextId('proj'), name, path, baseRef }
    projects.set(project.id, project)
    return project
  }

  const seedWorktree = (
    project: Project,
    name: string,
    branch: string,
    state: Worktree['state'],
    extra?: Partial<Worktree>
  ): Worktree => {
    const worktree: Worktree = {
      id: nextId('wt'),
      projectId: project.id,
      name,
      branch,
      path: `${project.path}/.worktrees/${branch.replace(/\//g, '-')}`,
      startedFrom: project.baseRef,
      state,
      createdAt: Date.now() - 1000 * 60 * 90,
      ...extra
    }
    worktrees.set(worktree.id, worktree)
    return worktree
  }

  const seedStatus = (worktree: Worktree, partial: Omit<WorktreeStatus, 'worktreeId' | 'branch' | 'readAt'>): void => {
    statuses.set(worktree.id, {
      worktreeId: worktree.id,
      branch: worktree.branch,
      readAt: Date.now(),
      ...partial
    })
  }

  // --- seed -----------------------------------------------------------------

  const atlas = seedProject('atlas', '/Users/dev/code/atlas', 'origin/main')
  const ledger = seedProject('ledger-api', '/Users/dev/code/ledger-api', 'origin/trunk')

  // One project the demo's own key is already in, one it is not, because the
  // difference between those two is the whole of what this dialog shows.
  rosters.set(atlas.id, [
    seededMember('ada', 'PkQtFYttlX7oLD8c/tYpNlHWLIflye3t6tMGm0I4iRk=', '2026-04-02'),
    seededMember('grace', 'tOZqe8RgnJt2KzVOWEfPkfYHQpB1i0Jt7Ojb9vDfjW4=', '2026-05-19'),
    { ...seededMember('you', SEEDED_PUBLIC_KEY, '2026-08-27'), isSelf: true }
  ])
  rosters.set(ledger.id, [seededMember('grace', 'tOZqe8RgnJt2KzVOWEfPkfYHQpB1i0Jt7Ojb9vDfjW4=', '2026-06-11')])
  // The same split for the other team-wide fact: one project has a relay
  // committed and one has none, which is what the panel is there to fix.
  relays.set(atlas.id, 'wss://relay.example/v1/relay')

  const search = seedWorktree(atlas, 'incremental search index', 'task/incremental-search', 'ready')
  const themes = seedWorktree(atlas, 'theme tokens pass', 'task/theme-tokens', 'ready')
  const flaky = seedWorktree(atlas, 'quarantine flaky suite', 'task/quarantine-flaky', 'creating')
  const migration = seedWorktree(ledger, 'ledger schema migration', 'task/schema-migration', 'ready')
  seedWorktree(ledger, 'retry webhook delivery', 'task/webhook-retry', 'failed', {
    error: "fatal: invalid reference 'origin/trunk'; fetch the remote and try again"
  })

  seedStatus(search, { ahead: 3, behind: 0, staged: 2, unstaged: 4, untracked: 1, conflicted: 0 })
  seedStatus(themes, { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  seedStatus(migration, {
    ahead: 1,
    behind: 12,
    staged: 0,
    unstaged: 3,
    untracked: 0,
    conflicted: 2
  })

  const searchShell = spawn(search.id, 'zsh', [
    dim('teamree · worktree ready in 1.9s'),
    `${good('✓')} branch ${accent(search.branch)} tracking ${dim('origin/main')}`
  ])
  const searchAgent = spawn(search.id, 'agent', [
    accent('▌ agent session'),
    dim('reading src/index/tokenizer.ts …'),
    `${good('✓')} 42 tests passed in 3.4s`,
    dim('waiting for instructions')
  ])
  const searchLogs = spawn(search.id, 'dev server', [
    dim('$ npm run dev'),
    `${good('ready')} http://localhost:5173`,
    dim('watching 318 modules')
  ])
  const themeShell = spawn(themes.id, 'zsh', [dim('teamree · nothing to report')])
  const migrationShell = spawn(migration.id, 'zsh', [
    `${warn('!')} 2 conflicted paths after rebase`,
    dim('db/schema.sql, db/migrations/0042_accounts.sql')
  ])

  // Priya has typed a command at the agent pane and has not been allowed yet.
  // The preview is the runtime's own safe rendering: the return that would
  // submit it is shown as a mark, so the demo shows the question as it really
  // arrives rather than as tidy prose.
  seededRequests.push({
    id: 'ask_1',
    projectId: search.projectId,
    terminalId: searchAgent.id,
    handle: 'priya',
    publicKey: SEEDED_PEER_KEY,
    since: Date.now() - 4_000,
    at: Date.now() - 3_000,
    expiresAt: Date.now() + 56_000,
    writes: 14,
    bytes: 14,
    preview: 'npm run build⏎',
    clipped: false
  })

  layouts.set(search.id, {
    worktreeId: search.id,
    focusedTerminalId: searchAgent.id,
    root: {
      kind: 'split',
      direction: 'row',
      sizes: [0.56, 0.44],
      children: [
        leaf(searchShell.id),
        {
          kind: 'split',
          direction: 'column',
          sizes: [0.62, 0.38],
          children: [leaf(searchAgent.id), leaf(searchLogs.id)]
        }
      ]
    }
  })
  layouts.set(themes.id, {
    worktreeId: themes.id,
    focusedTerminalId: themeShell.id,
    root: leaf(themeShell.id)
  })
  layouts.set(migration.id, {
    worktreeId: migration.id,
    focusedTerminalId: migrationShell.id,
    root: leaf(migrationShell.id)
  })

  // The demo's one live stream, so an idle window still shows the app breathing.
  const logLines = [
    `${dim('12:04:18')} ${good('GET')} /api/index/status ${dim('200 · 4ms')}`,
    `${dim('12:04:21')} ${accent('hmr')} update src/index/tokenizer.ts`,
    `${dim('12:04:27')} ${good('GET')} /api/index/search?q=pane ${dim('200 · 11ms')}`,
    `${dim('12:04:33')} ${warn('warn')} reindex queue depth 4`
  ]
  let logCursor = 0
  setInterval(() => {
    const terminal = terminals.get(searchLogs.id)
    if (!terminal?.record.running) return
    emit(terminal, { type: 'data', data: `${logLines[logCursor % logLines.length]}\r\n` })
    logCursor++
  }, 3200)

  // Background worktree creation, including the failure path, so the sidebar's
  // creating and failed states are reachable without a backend.
  const finishCreation = (worktreeId: string, shouldFail: boolean): void => {
    setTimeout(() => {
      const worktree = worktrees.get(worktreeId)
      if (!worktree || worktree.state !== 'creating') return
      if (shouldFail) {
        worktrees.set(worktreeId, {
          ...worktree,
          state: 'failed',
          error: `fatal: '${worktree.branch}' is already checked out at ${worktree.path}`
        })
        announce({ type: 'worktrees' })
        return
      }
      const ready: Worktree = { ...worktree, state: 'ready' }
      worktrees.set(worktreeId, ready)
      seedStatus(ready, {
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0
      })
      const shell = spawn(worktreeId, 'zsh', [
        dim('teamree · worktree ready'),
        `${good('✓')} ${accent(ready.branch)} from ${dim(ready.startedFrom)}`
      ])
      layouts.set(worktreeId, { worktreeId, focusedTerminalId: shell.id, root: leaf(shell.id) })
      announce({ type: 'worktrees' }, { type: 'terminals' }, { type: 'layout', worktreeId })
    }, CREATE_MS)
  }

  finishCreation(flaky.id, false)

  const memberList = (projectId: string): MemberList => {
    const project = required(projects.get(projectId), 'project')
    const members = rosters.get(projectId) ?? []
    const mine = members.find((member) => member.isSelf)
    const handle = mine?.handle ?? SEEDED_HANDLE
    return {
      projectId: project.id,
      members,
      problems: [],
      self: { handle, publicKey: SEEDED_PUBLIC_KEY },
      selfFile: `.teamree/members/${handle}.pub`,
      enrolled: mine !== undefined,
      watched: true,
      readAt: Date.now()
    }
  }

  /** The demo's one team-wide fact, and the environment saying nothing. */
  const relaySetting = (projectId: string): RelaySetting => {
    const url = relays.get(projectId) ?? null
    return {
      projectId,
      file: '.teamree/relay',
      url,
      source: url === null ? null : 'repository',
      problem:
        url === null
          ? 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
          : null,
      onDisk: { url, problem: null },
      override: { name: 'TEAMREE_RELAY_URL', value: null },
      // The seeded runtime has no app bundle to carry a relay project, and
      // saying so is the honest answer: the deploy button is disabled here,
      // with a sentence, rather than offering to run a command that is not
      // there.
      deploy: { command: null, reason: 'the seeded runtime carries no relay project to deploy' },
      readAt: Date.now()
    }
  }

  // --- method dispatch ------------------------------------------------------

  /**
   * Seeded: a packaged app, not linked, nobody asked yet, and a destination
   * only root can write — which is the one state where the demo has both the
   * first-run offer and the password sentence to show.
   */
  let cliLinked = false
  let cliAskedAt: number | null = null
  let automaticUpdates = true
  const cliStatus = (): CliStatus => ({
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    packaged: true,
    bundle: '/Applications/teamree.app/Contents/Resources/cli/teamree.mjs',
    // In /Applications rather than in the disk image it arrived in, which is
    // the one state where the panel has a button to demonstrate at all.
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: cliLinked ? 'linked' : 'absent',
    resolved: cliLinked ? '/Applications/teamree.app/Contents/Resources/cli/teamree' : null,
    dangling: false,
    needsAdministrator: !cliLinked,
    onPath: 'login',
    askedAt: cliAskedAt,
    readAt: Date.now()
  })

  let appearance: Appearance = DEFAULT_APPEARANCE
  const updateState = (): UpdateState => ({
    current: '0.0.1-demo',
    // Nothing to compare a demo build against, which is also what a checkout
    // says about itself — and it keeps this stand-in from advertising a release
    // that has nothing to do with what is running.
    checkable: false,
    automatic: automaticUpdates,
    available: null,
    checking: false,
    checkedAt: Date.now() - 60_000,
    problem: null
  })

  const handlers: { [M in MethodName]: (params: ParamsOf<M>) => ResultOf<M> } = {
    'status.get': () => ({
      version: '0.0.1-demo',
      endpoint: '/tmp/teamree.sock',
      pid: 4242,
      platform: 'darwin',
      startedAt: Date.now() - 90000
    }),

    'project.list': () => [...projects.values()],
    'project.add': ({ path, name }) => {
      const project: Project = {
        id: nextId('proj'),
        name: name ?? path.split('/').filter(Boolean).pop() ?? path,
        path,
        baseRef: 'origin/main'
      }
      projects.set(project.id, project)
      announce({ type: 'projects' })
      return project
    },
    'project.remove': ({ projectId }) => {
      projects.delete(projectId)
      for (const worktree of worktrees.values()) {
        if (worktree.projectId === projectId) worktrees.delete(worktree.id)
      }
      announce({ type: 'projects' }, { type: 'worktrees' })
      return { removed: true }
    },

    'worktree.list': ({ projectId }) =>
      [...worktrees.values()].filter((worktree) => !projectId || worktree.projectId === projectId),
    'worktree.get': ({ worktreeId }) => required(worktrees.get(worktreeId), 'worktree'),
    'worktree.create': ({ projectId, name, startedFrom, branch }) => {
      const project = required(projects.get(projectId), 'project')
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') || 'untitled'
      const worktree: Worktree = {
        id: nextId('wt'),
        projectId,
        name,
        branch: branch ?? `task/${slug}`,
        path: `${project.path}/.worktrees/${slug}`,
        startedFrom: startedFrom ?? project.baseRef,
        state: 'creating',
        createdAt: Date.now()
      }
      worktrees.set(worktree.id, worktree)
      announce({ type: 'worktrees' })
      // A task named "fail…" is the demo's reproducible failure path.
      finishCreation(worktree.id, /fail/i.test(name))
      return worktree
    },
    'worktree.remove': ({ worktreeId, force }) => {
      const status = statuses.get(worktreeId)
      const pending = status ? status.staged + status.unstaged + status.untracked + status.conflicted : 0
      // The same refusal the real runtime makes, so the confirmation this
      // provokes is demonstrable rather than only reachable against git.
      if (!force && pending > 0) {
        throw Object.assign(
          new Error(`worktree has ${pending} uncommitted changes; remove with force to discard them`),
          {
            code: 'conflict'
          }
        )
      }
      worktrees.delete(worktreeId)
      statuses.delete(worktreeId)
      layouts.delete(worktreeId)
      for (const terminal of terminals.values()) {
        if (terminal.record.worktreeId === worktreeId) terminals.delete(terminal.record.id)
      }
      announce({ type: 'worktrees' }, { type: 'terminals' })
      return { removed: true }
    },
    'worktree.startPoints': ({ projectId, limit }) => {
      const project = required(projects.get(projectId), 'project')
      // Branches this window has already made are start points in their own right.
      const fromWorktrees = [...worktrees.values()]
        .filter((row) => row.projectId === projectId)
        .map((row) => ({
          ref: row.branch,
          kind: 'localBranch' as const,
          minutesAgo: (Date.now() - row.createdAt) / 60_000
        }))
      const seeds = SEEDED_REFS[project.name] ?? REFS_FOR_A_NEW_PROJECT
      const rows = [...seeds, ...fromWorktrees].map(startPointRow)
      return capStartPoints(project.baseRef, rows, limit ?? SEEDED_LIMITS[project.name] ?? 200)
    },
    'worktree.status': ({ worktreeId }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const existing = statuses.get(worktreeId)
      const status: WorktreeStatus = existing
        ? { ...existing, readAt: Date.now() }
        : {
            worktreeId,
            branch: worktree.branch,
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            readAt: Date.now()
          }
      statuses.set(worktreeId, status)
      return status
    },
    'worktree.changes': ({ worktreeId, limit }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const all = status ? seededChanges(status) : []
      const cap = limit ?? 500
      return {
        worktreeId: worktree.id,
        changes: all.slice(0, cap),
        total: all.length,
        limit: cap,
        truncated: all.length > cap,
        readAt: Date.now()
      }
    },
    'worktree.commit': ({ worktreeId, message, paths }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const changes = status ? seededChanges(status) : []
      const captured = paths && paths.length > 0 ? paths : changes.filter((c) => c.staged).map((c) => c.path)
      // The seeded workspace moves with it: what was committed is no longer a
      // pending change, so the chips settle the way they would for real.
      if (status) {
        seedStatus(worktree, {
          ahead: status.ahead + 1,
          behind: status.behind,
          staged: 0,
          unstaged: status.unstaged,
          untracked: status.untracked,
          conflicted: status.conflicted
        })
      }
      announce({ type: 'worktrees' })
      const sha = nextId('sha').replace(/[^a-z0-9]/g, '')
      return {
        worktreeId,
        sha,
        shortSha: sha.slice(0, 7),
        message,
        paths: [...captured].sort(),
        committedAt: Date.now()
      }
    },
    'worktree.push': ({ worktreeId, remote }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const target = remote ?? 'origin'
      // Nothing ahead means nothing to send, which is the outcome worth seeing
      // in a demo as much as the other one.
      const alreadyUpToDate = (status?.ahead ?? 0) === 0
      if (status && !alreadyUpToDate) {
        seedStatus(worktree, { ...status, ahead: 0 })
        announce({ type: 'worktrees' })
      }
      return {
        worktreeId,
        remote: target,
        branch: worktree.branch,
        alreadyUpToDate,
        upstream: `${target}/${worktree.branch}`,
        setUpstream: false,
        uncommitted: (status?.staged ?? 0) + (status?.unstaged ?? 0),
        pushedAt: Date.now()
      }
    },
    'worktree.log': ({ worktreeId, limit }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const project = projects.get(worktree.projectId)
      const ahead = statuses.get(worktreeId)?.ahead ?? 0
      const subjects = [
        'rank results by recency, not just score',
        'pull the tie-break out of the comparator',
        'cover the empty-query case'
      ]
      const commits = Array.from({ length: ahead }, (_, index) => {
        const sha = `${nextId('c').replace(/[^a-z0-9]/g, '')}0000000000000000000000000000`.slice(0, 40)
        return {
          sha,
          shortSha: sha.slice(0, 7),
          author: 'you',
          committedAt: new Date(Date.now() - (index + 1) * 1_800_000).toISOString(),
          subject: subjects[index % subjects.length] as string
        }
      })
      const cap = limit ?? 50
      return {
        worktreeId,
        baseRef: project?.baseRef ?? 'origin/main',
        commits: commits.slice(0, cap),
        truncated: commits.length > cap,
        readAt: Date.now()
      }
    },
    'worktree.mergePreview': ({ worktreeId }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const project = projects.get(worktree.projectId)
      const status = statuses.get(worktreeId)
      // Seeded to match the chips: a worktree carrying conflicts is exactly the
      // one that would not go in cleanly.
      const conflicted = (status?.conflicted ?? 0) > 0
      return {
        worktreeId,
        baseRef: project?.baseRef ?? 'origin/main',
        state: conflicted ? 'conflicts' : (status?.ahead ?? 0) === 0 ? 'nothingToMerge' : 'clean',
        ahead: status?.ahead ?? 0,
        conflicts: conflicted
          ? seededChanges(status as WorktreeStatus)
              .slice(0, status?.conflicted ?? 0)
              .map((change) => change.path)
          : [],
        readAt: Date.now()
      }
    },
    'worktree.diff': ({ worktreeId, path, staged }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const changes = status ? seededChanges(status) : []
      const wanted = path === undefined ? changes.filter((change) => change.staged === (staged ?? false)) : [{ path }]
      return {
        worktreeId: worktree.id,
        ...(path === undefined ? {} : { path }),
        staged: staged ?? false,
        patch: wanted.map((change) => seededPatch(change.path)).join('\n'),
        truncated: false,
        readAt: Date.now()
      }
    },

    'teamwork.relay': ({ projectId }) => relaySetting(projectId),
    // Refused rather than faked. The seeded runtime has no repository behind
    // it, so a demo that claimed to have set a remote or made a commit would be
    // the one thing a demo must never be: a lie about somebody's git history.
    'teamwork.setOrigin': () => {
      throw new Error('the seeded runtime has no repository to add a remote to')
    },
    'teamwork.publishPlan': ({ projectId }) => ({
      projectId,
      files: [],
      message: 'Set up teamwork',
      remote: 'origin',
      branch: null,
      upstream: null,
      committed: false,
      blocker: 'The seeded runtime has no repository, so there is nothing to commit or push.',
      readAt: Date.now()
    }),
    'teamwork.publish': () => {
      throw new Error('the seeded runtime has no repository to commit to')
    },
    // Null rather than a fabricated run: the demo has no push to be partway
    // through, and a progress record here would put a moving percentage on a
    // thing that is not happening.
    'teamwork.publishProgress': () => null,
    'teamwork.cancelPublish': () => ({ cancelled: false }),
    'teamwork.setRelay': ({ projectId, url }) => {
      relays.set(projectId, url)
      announce({ type: 'members' })
      return relaySetting(projectId)
    },

    'members.list': ({ projectId }) => memberList(projectId),
    'members.join': ({ projectId, handle }) => {
      const roster = rosters.get(projectId) ?? []
      if (!roster.some((member) => member.isSelf)) {
        const name = handle ?? SEEDED_HANDLE
        rosters.set(projectId, [
          ...roster,
          {
            ...seededMember(name, SEEDED_PUBLIC_KEY, new Date().toISOString().slice(0, 10)),
            isSelf: true
          }
        ])
        announce({ type: 'members' })
      }
      return memberList(projectId)
    },

    // Teamwork, as the demo can honestly show it: a relay named, one teammate
    // connected and one whose machine is not. Inventing a refused link would be
    // inventing a security event, so the seeded data has none.
    'teamwork.status': ({ projectId }) => ({
      // Read, and not the honest "not read yet" a real runtime passes through
      // on its way here: the seeded workspace is a picture of a machine that
      // has been running for a while, and a demo that started every project as
      // unread would be showing a state that lasts milliseconds.
      state: 'read' as const,
      projectId,
      relay: { url: 'wss://relay.example/v1/relay', source: 'repository' as const },
      disabledReason: null,
      origin: { ok: true as const, url: 'https://example.com/team/pager.git' },
      enrolled: true,
      links: [
        {
          publicKey: SEEDED_PEER_KEY,
          handle: 'priya',
          phase: 'connected' as const,
          since: Date.now() - 900_000,
          attempts: 1
        },
        {
          publicKey: SEEDED_AWAY_KEY,
          handle: 'marcus',
          phase: 'waiting' as const,
          // A shut lid, which is the case the link's own silence deadline
          // names: the socket was never closed, this side gave up waiting.
          detail: 'your teammate’s machine stopped answering',
          since: Date.now() - 300_000,
          attempts: 3
        }
      ],
      readAt: Date.now()
    }),
    // Two teammates, because the two cases read differently: priya is
    // connected, and marcus's laptop is shut — his worktree stays exactly where
    // it was, out of the local cache, dated and not live.
    'teamwork.presence': ({ projectId }) => ({
      projectId,
      teammates: [
        {
          handle: 'marcus',
          publicKey: SEEDED_AWAY_KEY,
          connected: false,
          heardAt: Date.now() - 2_700_000
        },
        {
          handle: 'priya',
          publicKey: SEEDED_PEER_KEY,
          connected: true,
          heardAt: Date.now() - 4_000
        }
      ],
      worktrees: [
        {
          id: `peer:${SEEDED_AWAY_KEY.slice(0, 12)}:wt_remote_9`,
          handle: 'marcus',
          publicKey: SEEDED_AWAY_KEY,
          name: 'retry budget',
          branch: 'fix/retry-budget',
          state: 'ready' as const,
          heardAt: Date.now() - 2_700_000,
          live: false,
          panes: [
            {
              id: `peer:${SEEDED_AWAY_KEY.slice(0, 12)}:t_remote_9`,
              title: 'codex',
              shell: '/bin/zsh',
              agent: 'codex' as const,
              running: true,
              busy: false,
              quietForMs: 120_000
            }
          ]
        },
        {
          id: `peer:${SEEDED_PEER_KEY.slice(0, 12)}:wt_remote_1`,
          handle: 'priya',
          publicKey: SEEDED_PEER_KEY,
          name: 'index compaction',
          branch: 'perf/compaction',
          state: 'ready' as const,
          heardAt: Date.now() - 4_000,
          live: true,
          panes: [
            {
              id: `peer:${SEEDED_PEER_KEY.slice(0, 12)}:t_remote_1`,
              title: 'claude',
              shell: '/bin/zsh',
              agent: 'claude' as const,
              running: true,
              busy: true,
              cols: 96,
              rows: 30,
              quietForMs: 0
            },
            {
              id: `peer:${SEEDED_PEER_KEY.slice(0, 12)}:t_remote_2`,
              title: 'pytest',
              shell: '/bin/zsh',
              running: true,
              busy: false,
              cols: 120,
              rows: 40,
              quietForMs: 260_000
            }
          ]
        }
      ],
      readAt: Date.now()
    }),

    // A teammate's pane, as the demo can honestly show one: the scrollback it
    // joins at and nothing after it. There is no relay here and no teammate, so
    // inventing live output would be inventing a person.
    'teamwork.watch': ({ paneId }) => {
      const pane = SEEDED_WATCHABLE[paneId]
      if (!pane) throw new Error(`${paneId} is not a teammate’s pane`)
      return { subscription: nextId('sub'), cols: pane.cols, rows: pane.rows, handle: pane.handle }
    },
    // Typing into a teammate's pane, refused here rather than pretended at.
    // There is no relay and no teammate, so a keystroke has nowhere to land,
    // and answering "written" would be the one lie this feature must not tell.
    'teamwork.type': () => {
      throw new Error('there is no teammate to type to in the demo runtime')
    },
    // One teammate reading one of this machine's panes, and one who has typed
    // into it, so both halves of the owner's bargain are visible in the demo
    // rather than only in the design.
    'teamwork.watchers': ({ projectId }) => ({
      projectId,
      panes: [...terminals.keys()].slice(0, 1).map((terminalId) => ({
        terminalId,
        watchers: [{ handle: 'priya', publicKey: SEEDED_PEER_KEY, since: Date.now() - 120_000 }],
        typists: [
          {
            handle: 'priya',
            publicKey: SEEDED_PEER_KEY,
            since: Date.now() - 90_000,
            at: Date.now() - 40_000,
            writes: 12,
            bytes: 48,
            refused: 0
          }
        ],
        muted: seededMutes.has(terminalId)
      })),
      readAt: Date.now()
    }),
    // The one thing in this area a demo can do for real: a mute is local, needs
    // nobody's agreement, and takes effect on a machine that has no peers at all.
    'teamwork.mute': ({ terminalId, muted }) => {
      const worktreeId = terminals.get(terminalId)?.record.worktreeId
      const projectId = worktreeId === undefined ? undefined : worktrees.get(worktreeId)?.projectId
      if (projectId === undefined) throw new Error(`no pane of this machine with id ${terminalId}`)
      if (muted) seededMutes.add(terminalId)
      else seededMutes.delete(terminalId)
      announce({ type: 'teammates' })
      return handlers['teamwork.watchers']({ projectId })
    },
    // What is waiting on the owner, and what they have already settled. The
    // request is seeded against the first pane so the question is on screen
    // without a relay; answering it is real, and the row goes.
    'teamwork.requests': ({ projectId }) => ({
      projectId,
      requests: seededRequests.filter((request) => request.projectId === projectId),
      standing: [...seededGrants.values()],
      readAt: Date.now()
    }),
    'teamwork.decide': ({ requestId, decision }) => {
      const index = seededRequests.findIndex((request) => request.id === requestId)
      const request = seededRequests[index]
      if (request === undefined) throw new Error(`no keystrokes are waiting under id ${requestId}`)
      seededRequests.splice(index, 1)
      if (decision === 'session' || decision === 'always') {
        seededGrants.set(`${request.terminalId} ${request.publicKey}`, {
          terminalId: request.terminalId,
          handle: request.handle,
          publicKey: request.publicKey,
          scope: decision,
          since: Date.now()
        })
      }
      announce({ type: 'teammates' })
      return handlers['teamwork.requests']({ projectId: request.projectId })
    },
    'teamwork.revoke': ({ terminalId, publicKey }) => {
      const worktreeId = terminals.get(terminalId)?.record.worktreeId
      const projectId = worktreeId === undefined ? undefined : worktrees.get(worktreeId)?.projectId
      if (projectId === undefined) throw new Error(`no pane of this machine with id ${terminalId}`)
      seededGrants.delete(`${terminalId} ${publicKey}`)
      announce({ type: 'teammates' })
      return handlers['teamwork.requests']({ projectId })
    },
    // Seeded with one entry so the shape of the record is visible: who, when,
    // which pane, how much — and, deliberately, not a byte of what was typed.
    'teamwork.writeLog': ({ limit }) => {
      const writes = [...seededWrites]
      return {
        writes: limit === undefined ? writes : writes.slice(-limit),
        problem: null,
        readAt: Date.now()
      }
    },

    // PEER-ONLY, and refused here rather than seeded. These are what a teammate
    // calls over the peer transport; a window asking for one is a bug, and
    // answering it with invented data would hide that.
    'peer.presence': () => {
      throw new Error('peer.presence is a teammate’s call, not a window’s')
    },
    'peer.subscribe': () => {
      throw new Error('peer.subscribe is a teammate’s call, not a window’s')
    },

    'agent.list': () => [
      { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
      { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
    ],

    // The demo's CLI is not linked yet and its destination needs a password,
    // because that is the state the panel has something to say in — and the
    // button moves it, so pressing it demonstrates the outcome rather than a
    // spinner that ends where it started.
    'cli.status': () => cliStatus(),
    'cli.install': () => {
      const before = cliStatus()
      cliLinked = true
      cliAskedAt ??= Date.now()
      return { outcome: 'linked', replaced: null, administrator: before.needsAdministrator, status: cliStatus() }
    },
    'cli.dismissPrompt': () => {
      cliAskedAt ??= Date.now()
      return cliStatus()
    },

    // The seeded runtime is a demonstration, and a demonstration that reached
    // GitHub would not be one. It answers as a current build that has looked
    // recently: the card is worth showing in a screenshot, but not at the cost
    // of this file being the one place in the renderer that opens a socket.
    'update.state': () => updateState(),
    'update.check': () => updateState(),
    'update.setAutomatic': ({ automatic }) => {
      automaticUpdates = automatic
      return updateState()
    },
    'update.download': () => ({ opened: 'https://github.com/zero-abd/teamree/releases/latest' }),
    'terminal.list': ({ worktreeId }) =>
      [...terminals.values()]
        .map((terminal) => terminal.record)
        .filter((record) => !worktreeId || record.worktreeId === worktreeId),
    // A pane started with a command shows that command, not the shell it would
    // have been: the demo's job is to look like what the runtime actually does.
    'terminal.create': ({ worktreeId, cols, rows, command }) => {
      const record = command
        ? spawn(worktreeId, command, [accent(`▌ ${command}`), dim('reading the worktree …')])
        : spawn(worktreeId, 'zsh', [dim('teamree · new session')])
      const terminal = required(terminals.get(record.id), 'terminal')
      terminal.record = { ...record, cols: cols ?? record.cols, rows: rows ?? record.rows }
      const layout = layouts.get(worktreeId)
      if (!layout?.root) {
        layouts.set(worktreeId, {
          worktreeId,
          root: leaf(record.id),
          focusedTerminalId: record.id
        })
      } else {
        const root = layout.root
        const share = root.kind === 'split' && root.direction === 'row' ? 1 / (root.children.length + 1) : 0.5
        layouts.set(worktreeId, {
          worktreeId,
          focusedTerminalId: record.id,
          root:
            root.kind === 'split' && root.direction === 'row'
              ? {
                  ...root,
                  children: [...root.children, leaf(record.id)],
                  sizes: [...root.sizes.map((size) => size * (1 - share)), share]
                }
              : {
                  kind: 'split',
                  direction: 'row',
                  children: [root, leaf(record.id)],
                  sizes: [0.5, 0.5]
                }
        })
      }
      announce({ type: 'terminals' }, { type: 'layout', worktreeId })
      return terminal.record
    },
    'terminal.write': ({ terminalId, data }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      echo(terminal, data, emit, prompt)
      return { written: true }
    },
    'terminal.resize': ({ terminalId, cols, rows }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      terminal.record = { ...terminal.record, cols, rows }
      return terminal.record
    },
    'terminal.close': ({ terminalId }) => {
      const terminal = terminals.get(terminalId)
      if (terminal) {
        terminal.record = { ...terminal.record, running: false, exitCode: 0 }
        emit(terminal, { type: 'exit', exitCode: 0 })
        terminals.delete(terminalId)
        announce(
          { type: 'terminalExited', terminalId, exitCode: 0 },
          { type: 'terminals' },
          { type: 'layout', worktreeId: terminal.record.worktreeId }
        )
      }
      return { closed: true }
    },
    'terminal.read': ({ terminalId, tailBytes }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      return { data: tailBytes ? terminal.buffer.slice(-tailBytes) : terminal.buffer }
    },
    'terminal.subscribe': ({ terminalId }) => {
      required(terminals.get(terminalId), 'terminal')
      return { subscription: nextId('sub') }
    },
    'terminal.split': ({ terminalId, direction }) => {
      const source = required(terminals.get(terminalId), 'terminal')
      const worktreeId = source.record.worktreeId
      const record = spawn(worktreeId, 'zsh', [dim('teamree · split pane')])
      const current = layouts.get(worktreeId)
      const layout: Layout = {
        worktreeId,
        root: splitPane(current?.root ?? null, terminalId, direction, record.id),
        focusedTerminalId: record.id
      }
      layouts.set(worktreeId, layout)
      announce({ type: 'terminals' }, { type: 'layout', worktreeId })
      return { terminal: record, layout }
    },

    // Held for the life of the page rather than written anywhere: the seeded
    // runtime has no disk, and a demo that claimed to have remembered a theme
    // would be claiming to have written a file it never wrote.
    'appearance.get': () => appearance,
    'appearance.set': (next) => {
      appearance = sanitizeAppearance(next)
      return appearance
    },

    'layout.get': ({ worktreeId }) => layouts.get(worktreeId) ?? { worktreeId, root: null, focusedTerminalId: null },
    'layout.set': ({ worktreeId, root, focusedTerminalId }) => {
      const layout: Layout = {
        worktreeId,
        root: (root as PaneNode | null) ?? null,
        focusedTerminalId
      }
      layouts.set(worktreeId, layout)
      announce({ type: 'layout', worktreeId })
      return layout
    },

    // The renderer watches through `watchWorkspace` below rather than this
    // method, which exists only to keep the catalogue complete.
    'workspace.subscribe': () => ({ subscription: nextId('sub') }),

    unsubscribe: () => ({ unsubscribed: true })
  }

  return {
    get connection() {
      return connection
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
    async call(method, params) {
      await sleep(LATENCY_MS)
      const handler = handlers[method] as (input: unknown) => unknown
      return handler(params) as ResultOf<typeof method>
    },
    watchWorkspace(onEvent) {
      workspaceWatchers.add(onEvent)
      let closed = false
      return {
        close: () => {
          if (closed) return
          closed = true
          workspaceWatchers.delete(onEvent)
        }
      }
    },
    async watchPane(projectId, paneId, onEvent) {
      await sleep(LATENCY_MS)
      const opened = handlers['teamwork.watch']({ projectId, paneId })
      // The scrollback, and then silence: a demo with no peer has nothing live
      // to say, and saying something anyway would be inventing a teammate.
      onEvent({ type: 'data', data: SEEDED_WATCHABLE[paneId]?.scrollback ?? '' })
      return {
        subscription: { close: () => {} },
        cols: opened.cols,
        rows: opened.rows,
        handle: opened.handle
      }
    },
    async subscribeTerminal(terminalId, onEvent) {
      await sleep(LATENCY_MS)
      const terminal = terminals.get(terminalId)
      if (!terminal) return { close: () => {} }
      terminal.listeners.add(onEvent)
      let closed = false
      const subscription: Subscription = {
        close: () => {
          if (closed) return
          closed = true
          terminal.listeners.delete(onEvent)
        }
      }
      return subscription
    }
  }
}

/** Line-disciplined echo: enough of a shell for the layout to feel alive. */
function echo(
  terminal: FakeTerminal,
  data: string,
  emit: (terminal: FakeTerminal, event: TerminalEvent) => void,
  prompt: (terminal: FakeTerminal) => string
): void {
  for (const char of data) {
    if (char === '\r') {
      const command = terminal.line.trim()
      terminal.line = ''
      emit(terminal, { type: 'data', data: '\r\n' })
      if (command) {
        emit(terminal, {
          type: 'data',
          data: `${dim(`demo runtime: '${command}' was not run`)}\r\n`
        })
      }
      emit(terminal, { type: 'data', data: prompt(terminal) })
    } else if (char === '\u007f' || char === '\b') {
      if (terminal.line.length > 0) {
        terminal.line = terminal.line.slice(0, -1)
        emit(terminal, { type: 'data', data: '\b \b' })
      }
    } else if (char >= ' ') {
      terminal.line += char
      emit(terminal, { type: 'data', data: char })
    }
  }
}

// --- start points ------------------------------------------------------------
//
// A repository's refs are the one thing the demo cannot derive from its own
// worktrees, so they are seeded outright, remotes and tags included: a stand-in
// that only ever showed local branches would leave the picker's other sections
// and its truncation notice unexercised in the browser.

type SeedRef = { ref: string; kind: StartPoint['kind']; minutesAgo: number; current?: boolean }

const SEEDED_REFS: Record<string, SeedRef[]> = {
  atlas: [
    { ref: 'main', kind: 'localBranch', minutesAgo: 26, current: true },
    { ref: 'legacy/import-pipeline', kind: 'localBranch', minutesAgo: 60 * 24 * 96 },
    { ref: 'origin/main', kind: 'remoteBranch', minutesAgo: 24 },
    { ref: 'origin/next', kind: 'remoteBranch', minutesAgo: 60 * 7 },
    { ref: 'origin/release-4.2', kind: 'remoteBranch', minutesAgo: 60 * 31 },
    { ref: 'origin/hotfix/token-leak', kind: 'remoteBranch', minutesAgo: 60 * 3 },
    { ref: 'upstream/main', kind: 'remoteBranch', minutesAgo: 60 * 19 },
    { ref: 'v4.2.0', kind: 'tag', minutesAgo: 60 * 24 * 5 },
    { ref: 'v4.1.3', kind: 'tag', minutesAgo: 60 * 24 * 41 },
    { ref: 'v4.0.0', kind: 'tag', minutesAgo: 60 * 24 * 190 }
  ],
  'ledger-api': [
    { ref: 'trunk', kind: 'localBranch', minutesAgo: 52, current: true },
    { ref: 'origin/trunk', kind: 'remoteBranch', minutesAgo: 41 },
    { ref: 'v2.9.0', kind: 'tag', minutesAgo: 60 * 24 * 12 },
    { ref: 'v2.8.4', kind: 'tag', minutesAgo: 60 * 24 * 33 },
    // A wall of stale integration branches, which is what a long-lived
    // repository looks like and what makes the cap worth showing.
    ...Array.from({ length: 46 }, (_, index) => ({
      ref: `origin/integration/batch-${String(index + 1).padStart(3, '0')}`,
      kind: 'remoteBranch' as const,
      minutesAgo: 60 * 24 * (index + 2)
    }))
  ]
}

/** Projects whose listing is deliberately capped, to exercise `truncated`. */
const SEEDED_LIMITS: Record<string, number> = { 'ledger-api': 14 }

const REFS_FOR_A_NEW_PROJECT: SeedRef[] = [
  { ref: 'main', kind: 'localBranch', minutesAgo: 12, current: true },
  { ref: 'origin/main', kind: 'remoteBranch', minutesAgo: 12 }
]

function startPointRow(seed: SeedRef): StartPoint {
  const sha = fakeSha(seed.ref)
  const namespace = seed.kind === 'tag' ? 'tags' : seed.kind === 'remoteBranch' ? 'remotes' : 'heads'
  return {
    ref: seed.ref,
    kind: seed.kind,
    sha,
    shortSha: sha.slice(0, 7),
    refName: `refs/${namespace}/${seed.ref}`,
    isBase: false,
    isCurrent: seed.current === true,
    updatedAt: Math.round((Date.now() - seed.minutesAgo * 60_000) / 1000)
  }
}

/** Marks the base ref, orders exactly as the runtime does, then applies the cap. */
function capStartPoints(baseRef: string, rows: StartPoint[], limit: number): StartPointList {
  const rank = (option: StartPoint): number => {
    if (option.isBase) return 0
    if (option.isCurrent) return 1
    return { head: 2, localBranch: 3, remoteBranch: 4, tag: 5, commit: 6 }[option.kind]
  }
  const marked = rows.map((row) => (row.ref === baseRef ? { ...row, isBase: true } : row))
  marked.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.ref.localeCompare(b.ref))
  return {
    baseRef,
    options: marked.slice(0, limit),
    total: marked.length,
    limit,
    truncated: marked.length > limit
  }
}

/** Stable digits per ref name, so a row keeps its sha across refetches. */
function fakeSha(ref: string): string {
  let hash = 0x81_1c_9d_c5
  for (const character of ref) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01_00_01_93) >>> 0
  let sha = ''
  let state = hash
  while (sha.length < 40) {
    state = Math.imul(state ^ (state >>> 15), 0x25_45_f4_91) >>> 0
    sha += state.toString(16).padStart(8, '0')
  }
  return sha.slice(0, 40)
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`not_found: ${what}`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
