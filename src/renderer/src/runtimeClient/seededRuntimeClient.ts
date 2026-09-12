// A stand-in runtime that answers the whole method catalogue from memory, so
// the interface is demonstrable — splits, background worktree creation,
// failures, live terminal output — before the real transport exists. It is
// deliberately the only place in the renderer that fabricates data.

import type { Layout, PaneNode, Project, Terminal, Worktree, WorktreeStatus } from '@shared/entities'
import type { MethodName, ParamsOf, ResultOf, TerminalEvent } from '@shared/methods'
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

export function createSeededRuntimeClient(): RuntimeClient {
  const projects = new Map<string, Project>()
  const worktrees = new Map<string, Worktree>()
  const statuses = new Map<string, WorktreeStatus>()
  const terminals = new Map<string, FakeTerminal>()
  const layouts = new Map<string, Layout>()

  let connection: ConnectionState = { phase: 'connecting', detail: 'Starting runtime' }
  const connectionListeners = new Set<(state: ConnectionState) => void>()

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
    statuses.set(worktree.id, { worktreeId: worktree.id, branch: worktree.branch, readAt: Date.now(), ...partial })
  }

  // --- seed -----------------------------------------------------------------

  const atlas = seedProject('atlas', '/Users/dev/code/atlas', 'origin/main')
  const ledger = seedProject('ledger-api', '/Users/dev/code/ledger-api', 'origin/trunk')

  const search = seedWorktree(atlas, 'incremental search index', 'task/incremental-search', 'ready')
  const themes = seedWorktree(atlas, 'theme tokens pass', 'task/theme-tokens', 'ready')
  const flaky = seedWorktree(atlas, 'quarantine flaky suite', 'task/quarantine-flaky', 'creating')
  const migration = seedWorktree(ledger, 'ledger schema migration', 'task/schema-migration', 'ready')
  seedWorktree(ledger, 'retry webhook delivery', 'task/webhook-retry', 'failed', {
    error: "fatal: invalid reference 'origin/trunk'; fetch the remote and try again"
  })

  seedStatus(search, { ahead: 3, behind: 0, staged: 2, unstaged: 4, untracked: 1, conflicted: 0 })
  seedStatus(themes, { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  seedStatus(migration, { ahead: 1, behind: 12, staged: 0, unstaged: 3, untracked: 0, conflicted: 2 })

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
  layouts.set(themes.id, { worktreeId: themes.id, focusedTerminalId: themeShell.id, root: leaf(themeShell.id) })
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
        return
      }
      const ready: Worktree = { ...worktree, state: 'ready' }
      worktrees.set(worktreeId, ready)
      seedStatus(ready, { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
      const shell = spawn(worktreeId, 'zsh', [
        dim('teamree · worktree ready'),
        `${good('✓')} ${accent(ready.branch)} from ${dim(ready.startedFrom)}`
      ])
      layouts.set(worktreeId, { worktreeId, focusedTerminalId: shell.id, root: leaf(shell.id) })
    }, CREATE_MS)
  }

  finishCreation(flaky.id, false)

  // --- method dispatch ------------------------------------------------------

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
      return project
    },
    'project.remove': ({ projectId }) => {
      projects.delete(projectId)
      for (const worktree of worktrees.values()) {
        if (worktree.projectId === projectId) worktrees.delete(worktree.id)
      }
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
      // A task named "fail…" is the demo's reproducible failure path.
      finishCreation(worktree.id, /fail/i.test(name))
      return worktree
    },
    'worktree.remove': ({ worktreeId }) => {
      worktrees.delete(worktreeId)
      statuses.delete(worktreeId)
      layouts.delete(worktreeId)
      for (const terminal of terminals.values()) {
        if (terminal.record.worktreeId === worktreeId) terminals.delete(terminal.record.id)
      }
      return { removed: true }
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

    'terminal.list': ({ worktreeId }) =>
      [...terminals.values()]
        .map((terminal) => terminal.record)
        .filter((record) => !worktreeId || record.worktreeId === worktreeId),
    'terminal.create': ({ worktreeId, cols, rows }) => {
      const record = spawn(worktreeId, 'zsh', [dim('teamree · new session')])
      const terminal = required(terminals.get(record.id), 'terminal')
      terminal.record = { ...record, cols: cols ?? record.cols, rows: rows ?? record.rows }
      const layout = layouts.get(worktreeId)
      if (!layout?.root) {
        layouts.set(worktreeId, { worktreeId, root: leaf(record.id), focusedTerminalId: record.id })
      }
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
      return { terminal: record, layout }
    },

    'layout.get': ({ worktreeId }) => layouts.get(worktreeId) ?? { worktreeId, root: null, focusedTerminalId: null },
    'layout.set': ({ worktreeId, root, focusedTerminalId }) => {
      const layout: Layout = { worktreeId, root: (root as PaneNode | null) ?? null, focusedTerminalId }
      layouts.set(worktreeId, layout)
      return layout
    },

    // Nothing in memory mutates behind the demo's back, so the stream is opened
    // and simply stays quiet.
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
        emit(terminal, { type: 'data', data: `${dim(`demo runtime: '${command}' was not run`)}\r\n` })
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

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`not_found: ${what}`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
