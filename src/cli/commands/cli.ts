// The CLI, on the subject of itself: where it is linked and how to link it.
//
// Here as well as in the window because everything the window can do the CLI
// can do, and because this is the one command somebody runs from a terminal
// that already has the app open — `teamree cli status` answers "why is the
// command I just typed driving the wrong copy" without hunting for a dialog.

import type { CliStatus } from '../../shared/entities.js'
import type { CommandSpec } from '../command-spec.js'
import { formatFields } from '../output.js'

/** What is at the destination, in the words a terminal has room for. */
function describeState(status: CliStatus): string {
  switch (status.state) {
    case 'linked':
      return 'links to this app'
    case 'elsewhere':
      return `links to ${status.resolved ?? 'somewhere else'}, which is not this app`
    case 'file':
      return 'a regular file is in the way'
    case 'directory':
      return 'a directory is in the way'
    case 'absent':
      return 'nothing there'
  }
}

function describePath(status: CliStatus): string {
  if (status.onPath === 'environment') return `yes, ${status.directory} is on this app’s PATH`
  if (status.onPath === 'shell') return `yes, ${status.directory} is on your login shell’s PATH`
  if (status.onPath === 'login')
    return `yes, ${status.directory} is in /etc/paths (your login shell could not be asked)`
  return `no — nothing teamree can read puts ${status.directory} on a PATH`
}

function statusFields(status: CliStatus): ReadonlyArray<readonly [string, string]> {
  return [
    ['cli', status.source ?? 'this build ships none'],
    ['link', status.destination],
    ['state', describeState(status)],
    ['on PATH', describePath(status)],
    ['password', status.needsAdministrator ? `needed to write ${status.directory}` : 'not needed'],
    ['platform', status.installable ? status.platform : `${status.platform} — teamree can only link it itself on macOS`]
  ]
}

export const cliCommands: readonly CommandSpec[] = [
  {
    path: ['cli', 'status'],
    summary: 'Show where the teamree CLI is linked and whether it is this app’s.',
    details:
      'A link that exists and points at a different copy of teamree is the confusing one: the command runs, ' +
      'and it drives the other app.',
    examples: ['teamree cli status --json'],
    run: async (context) => {
      const status = await context.client.call('cli.status', {})
      return { data: status, text: formatFields(statusFields(status)) }
    }
  },
  {
    path: ['cli', 'install'],
    summary: 'Link the teamree CLI into /usr/local/bin.',
    details:
      'macOS only. Asks for an administrator password only when /usr/local/bin cannot be written without one. ' +
      'A link that already points at this app is success, not an error. A regular file at the destination is ' +
      'left alone and reported.',
    examples: ['teamree cli install'],
    run: async (context) => {
      const result = await context.client.call('cli.install', {})
      const { status } = result
      const lines: string[] = []
      if (result.outcome === 'already-linked') lines.push(`${status.destination} already points at this app.`)
      else if (result.outcome === 'replaced') {
        lines.push(`${status.destination} now points at ${status.source}; it used to point at ${result.replaced}.`)
      } else lines.push(`${status.destination} now points at ${status.source}.`)
      if (result.administrator) lines.push('An administrator password was asked for.')
      if (status.onPath === null) {
        lines.push(`${status.directory} is not on any PATH teamree can read, so add it to your shell profile.`)
      }
      return { data: result, text: lines.join('\n') }
    }
  }
]
