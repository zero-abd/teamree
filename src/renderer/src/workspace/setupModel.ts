// What the welcome and Setup… say teamree found, one row per thing to set up, each done or not.

import type { CliStatus, InstalledAgent, Project } from '@shared/entities'
import { HARNESSES } from '../agents/harnesses'
import { cliPanel, offerCliInstall } from '../dialogs/cliInstallModel'
import { noticeTestStatus, type NoticeTestResult } from '../notices/noticeTestModel'
import type { AgentNoticePreference } from '../state/preferences'

export type SetupRowId = 'agents' | 'notifications' | 'cli' | 'project'

export type SetupAction =
  | 'recheck-agents'
  | 'send-test'
  | 'turn-on-notices'
  | 'notice-settings'
  | 'install-cli'
  | 'new-project'
  | 'open-folder'
  | 'clone'
  | 'join'

export type SetupRow = {
  id: SetupRowId
  label: string
  /** `waiting` until the probe behind the row has answered; `elsewhere` works, through another copy. */
  state: 'done' | 'todo' | 'waiting' | 'elsewhere'
  /** What was found, in a few words; null when the chips say it. */
  value: string | null
  /** The agents found, each with its version. */
  chips: readonly string[]
  actions: readonly { id: SetupAction; label: string }[]
}

export type SetupFacts = {
  agents: readonly InstalledAgent[]
  agentsProbed: boolean
  notices: AgentNoticePreference
  /** What the last Send Test came to, this session. */
  noticeTest: NoticeTestResult | null
  platform: string
  cli: CliStatus | null
  projects: readonly Pick<Project, 'name'>[]
}

export function setupRows(facts: SetupFacts): SetupRow[] {
  return [agentsRow(facts), noticesRow(facts), cliRow(facts.cli), projectRow(facts.projects)]
}

/** The Default agent picker only has a choice to offer with two agents or more. */
export function offersDefaultAgent(agents: readonly InstalledAgent[]): boolean {
  return agents.length >= 2
}

const row = (id: SetupRowId, label: string, rest: Omit<SetupRow, 'id' | 'label' | 'chips'>): SetupRow => ({
  id,
  label,
  chips: [],
  ...rest
})

function agentsRow({ agents, agentsProbed }: SetupFacts): SetupRow {
  if (!agentsProbed) return row('agents', 'Agents', { state: 'waiting', value: 'Looking…', actions: [] })
  if (agents.length === 0) {
    return row('agents', 'Agents', {
      state: 'todo',
      value: 'None found',
      actions: [{ id: 'recheck-agents', label: 'Recheck' }]
    })
  }
  return {
    ...row('agents', 'Agents', { state: 'done', value: null, actions: [] }),
    chips: agents.map((agent) => [HARNESSES[agent.kind].name, agent.version].filter(Boolean).join(' '))
  }
}

function noticesRow({ notices, noticeTest, platform }: SetupFacts): SetupRow {
  if (notices === 'off' || noticeTest === 'off') {
    return row('notifications', 'Notifications', {
      state: 'todo',
      value: 'Off',
      actions: [{ id: 'turn-on-notices', label: 'Turn On' }]
    })
  }
  const test = { id: 'send-test', label: 'Send Test' } as const
  if (noticeTest === 'blocked') {
    const status = noticeTestStatus(noticeTest, platform)
    return row('notifications', 'Notifications', {
      state: 'todo',
      value: status?.text ?? 'Blocked',
      actions: status?.openSettings ? [test, { id: 'notice-settings', label: 'Open Settings' }] : [test]
    })
  }
  return row('notifications', 'Notifications', {
    state: 'done',
    value: noticeTest === 'sent' ? 'Sent' : notices === 'sound' ? 'On · Sound' : 'On',
    actions: [test]
  })
}

function cliRow(status: CliStatus | null): SetupRow {
  const panel = cliPanel(status)
  if (status === null) return row('cli', 'Command Line', { state: 'waiting', value: panel.headline, actions: [] })
  if (offerCliInstall(status) && panel.action !== null) {
    return row('cli', 'Command Line', {
      state: 'todo',
      value: panel.headline,
      actions: [{ id: 'install-cli', label: `${panel.action}…` }]
    })
  }
  // A working link to another copy that this copy leaves alone still runs a teamree, just not this one.
  const state =
    status.state === 'linked' ? 'done' : status.state === 'elsewhere' && !status.dangling ? 'elsewhere' : 'todo'
  return row('cli', 'Command Line', { state, value: panel.headline, actions: [] })
}

function projectRow(projects: SetupFacts['projects']): SetupRow {
  if (projects.length === 0) {
    return row('project', 'Projects', {
      state: 'todo',
      value: 'None',
      actions: [
        { id: 'new-project', label: 'New Project…' },
        { id: 'open-folder', label: 'Open Folder…' },
        { id: 'clone', label: 'Clone Repository…' },
        { id: 'join', label: 'Join a Team…' }
      ]
    })
  }
  const value = projects.length === 1 ? (projects[0]?.name ?? '') : `${projects.length} projects`
  return row('project', 'Projects', { state: 'done', value, actions: [] })
}
