import { describe, expect, it } from 'vitest'
import type { CliStatus, InstalledAgent } from '@shared/entities'
import { offersDefaultAgent, setupRows, type SetupFacts, type SetupRow } from './setupModel'

const CLAUDE: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude', version: '2.1.3' }
const CODEX: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/homebrew/bin/codex', version: '0.40.0' }

function facts(patch: Partial<SetupFacts> = {}): SetupFacts {
  return {
    agents: [CLAUDE, CODEX],
    agentsProbed: true,
    notices: 'notify',
    noticeTest: null,
    platform: 'darwin',
    cli: cli(),
    projects: [],
    ...patch
  }
}

function cli(patch: Partial<CliStatus> = {}): CliStatus {
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
    onPath: 'shell',
    askedAt: null,
    readAt: 0,
    ...patch
  }
}

function row(rows: readonly SetupRow[], id: SetupRow['id']): SetupRow {
  const found = rows.find((each) => each.id === id)
  if (!found) throw new Error(`no ${id} row`)
  return found
}

const labels = (found: SetupRow): string[] => found.actions.map((action) => action.label)

describe('setupRows', () => {
  it('reads Agents, Notifications, Command Line, Projects in that order', () => {
    expect(setupRows(facts()).map((each) => each.label)).toEqual([
      'Agents',
      'Notifications',
      'Command Line',
      'Projects'
    ])
  })

  it('needs action with no agent on PATH, and offers a recheck', () => {
    const agents = row(setupRows(facts({ agents: [] })), 'agents')
    expect(agents).toMatchObject({ state: 'todo', value: 'None found', chips: [] })
    expect(labels(agents)).toEqual(['Recheck'])
    expect(offersDefaultAgent([])).toBe(false)
  })

  it('is done with one agent, named with its version, and has no choice to offer', () => {
    const agents = row(setupRows(facts({ agents: [CLAUDE] })), 'agents')
    expect(agents).toMatchObject({ state: 'done', value: null, chips: ['Claude Code 2.1.3'] })
    expect(agents.actions).toEqual([])
    expect(offersDefaultAgent([CLAUDE])).toBe(false)
  })

  it('lists both agents in discovery order and offers the default pick', () => {
    const agents = row(setupRows(facts()), 'agents')
    expect(agents).toMatchObject({ state: 'done', chips: ['Claude Code 2.1.3', 'Codex 0.40.0'] })
    expect(offersDefaultAgent([CLAUDE, CODEX])).toBe(true)
  })

  it('names an agent whose version could not be read without one', () => {
    const { version: _dropped, ...bare } = CODEX
    expect(row(setupRows(facts({ agents: [bare] })), 'agents').chips).toEqual(['Codex'])
  })

  it('waits, and claims nothing, until the probe is back', () => {
    const agents = row(setupRows(facts({ agents: [], agentsProbed: false })), 'agents')
    expect(agents).toMatchObject({ state: 'waiting', actions: [] })
  })

  it('is done with the CLI linked, and offers nothing', () => {
    const line = row(setupRows(facts({ cli: cli({ state: 'linked', resolved: cli().source }) })), 'cli')
    expect(line).toMatchObject({ state: 'done', value: 'On your PATH', actions: [] })
  })

  it('offers Install… when the CLI is not on PATH', () => {
    const line = row(setupRows(facts()), 'cli')
    expect(line).toMatchObject({ state: 'todo', value: 'Not on your PATH' })
    expect(labels(line)).toEqual(['Install…'])
  })

  it('offers nothing it cannot do: a build with no CLI, or no answer yet', () => {
    expect(row(setupRows(facts({ cli: cli({ source: null }) })), 'cli')).toMatchObject({
      state: 'todo',
      value: 'No CLI in this build',
      actions: []
    })
    expect(row(setupRows(facts({ cli: null })), 'cli')).toMatchObject({ state: 'waiting', actions: [] })
  })

  it('offers only what the install panel offers for a link to another copy', () => {
    const other = cli({ state: 'elsewhere', resolved: '/opt/teamree/cli/teamree', copy: 'installed' })
    expect(labels(row(setupRows(facts({ cli: other })), 'cli'))).toEqual(['Repair…'])
  })

  it('never offers Repair on a separate profile, and marks a working link to another copy apart from done', () => {
    const working = cli({ state: 'elsewhere', resolved: '/Applications/teamree.app/cli/teamree', copy: 'profile' })
    expect(row(setupRows(facts({ cli: working })), 'cli')).toMatchObject({
      state: 'elsewhere',
      value: 'Linked to another copy',
      actions: []
    })
    const broken = cli({ state: 'elsewhere', resolved: '/gone/teamree', dangling: true, copy: 'profile' })
    expect(row(setupRows(facts({ cli: broken })), 'cli')).toMatchObject({ state: 'todo', actions: [] })
  })

  it('is done with notifications on, and offers Send Test', () => {
    const notices = row(setupRows(facts()), 'notifications')
    expect(notices).toMatchObject({ state: 'done', value: 'On' })
    expect(labels(notices)).toEqual(['Send Test'])
    expect(row(setupRows(facts({ notices: 'sound' })), 'notifications').value).toBe('On · Sound')
    expect(row(setupRows(facts({ noticeTest: 'sent' })), 'notifications').value).toBe('Sent')
  })

  it('needs action with notifications off, and turns them on', () => {
    const notices = row(setupRows(facts({ notices: 'off' })), 'notifications')
    expect(notices).toMatchObject({ state: 'todo', value: 'Off' })
    expect(labels(notices)).toEqual(['Turn On'])
  })

  it('needs action when the system blocks them, and opens its settings where there is a page', () => {
    const mac = row(setupRows(facts({ noticeTest: 'blocked' })), 'notifications')
    expect(mac).toMatchObject({ state: 'todo', value: 'Blocked by macOS' })
    expect(labels(mac)).toEqual(['Send Test', 'Open Settings'])
    const linux = row(setupRows(facts({ noticeTest: 'blocked', platform: 'linux' })), 'notifications')
    expect(labels(linux)).toEqual(['Send Test'])
  })

  it('offers the three ways to a project until there is one', () => {
    const none = row(setupRows(facts()), 'project')
    expect(none).toMatchObject({ state: 'todo', value: 'None' })
    expect(labels(none)).toEqual(['New Project…', 'Open Folder…', 'Clone Repository…'])

    expect(row(setupRows(facts({ projects: [{ name: 'pager' }] })), 'project')).toMatchObject({
      state: 'done',
      value: 'pager',
      actions: []
    })
    expect(row(setupRows(facts({ projects: [{ name: 'pager' }, { name: 'api' }] })), 'project').value).toBe(
      '2 projects'
    )
  })
})
