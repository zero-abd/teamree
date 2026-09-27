// The pane host that Keep Agents Running leaves behind a quit. Through the app while it runs, since a
// second connection to the host would take the app's place; straight to the host once the app has gone.

import type { PaneHostStatus } from '../../shared/entities.js'
import { peekHost, stopHost } from '../../main/paneHost/hosting.js'
import type { CommandContext, CommandSpec } from '../command-spec.js'
import { formatFields } from '../output.js'

const CLI_VERSION = 'cli'

export const panes = (count: number): string => `${count} ${count === 1 ? 'pane' : 'panes'}`

async function status(context: CommandContext): Promise<PaneHostStatus> {
  if (context.connected) return context.client.call('paneHost.status', {})
  const host = await peekHost(context.profile, CLI_VERSION)
  return host === null
    ? { running: false, panes: 0, inProcess: 0, shells: 0 }
    : { running: true, pid: host.pid, panes: host.panes ?? 0, inProcess: 0, shells: 0 }
}

export const hostCommands: readonly CommandSpec[] = [
  {
    path: ['host', 'status'],
    summary: 'Show whether the pane host is running, and how many panes it keeps.',
    details:
      'With Keep Agents Running on, panes run in a separate host process that outlives the app. Works with ' +
      'or without the app running. `in app` counts the panes that still end when the app quits.',
    examples: ['teamree host status', 'teamree host status --json'],
    appOptional: true,
    run: async (context) => {
      const found = await status(context)
      return {
        data: found,
        text: formatFields([
          ['host', found.running ? `running, pid ${found.pid}` : 'not running'],
          ['panes', String(found.panes)],
          ...(context.connected ? [['in app', String(found.inProcess)] as [string, string]] : [])
        ])
      }
    }
  },
  {
    path: ['host', 'stop'],
    summary: 'Stop the pane host and every pane running in it.',
    details: 'The agents in those panes are ended. Works with or without the app running.',
    examples: ['teamree host stop'],
    appOptional: true,
    run: async (context) => {
      const stopped = context.connected
        ? await context.client.call('paneHost.stop', {})
        : await stopHost(context.profile, CLI_VERSION).then((host) =>
            host === null ? { stopped: false, panes: 0 } : { stopped: true, pid: host.pid, panes: host.panes ?? 0 }
          )
      return {
        data: stopped,
        text: stopped.stopped ? `stopped pid ${stopped.pid}, ended ${panes(stopped.panes)}` : 'no pane host running'
      }
    }
  }
]
