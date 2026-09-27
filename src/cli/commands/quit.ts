// Ending the app from a shell. A signal is the wrong ending: the ptys, socket,
// discovery file and transcripts are released by `before-quit`, which only the
// app's own quit runs.

import { readBoolean, readNumber } from '../argv.js'
import type { CommandSpec } from '../command-spec.js'
import { CliError, ExitCode } from '../exit.js'
import { formatFields } from '../output.js'
import { panes } from './host.js'
import { DEFAULT_QUIT_TIMEOUT_MS, waitForAppGone } from '../waiting.js'

/** Failures that are as likely to be the app leaving as they are a fault. */
const LEAVING = new Set(['connection_lost', 'connection_closed'])

export const quitCommands: readonly CommandSpec[] = [
  {
    path: ['quit'],
    summary: 'Quit the running app, and wait until it has gone.',
    details:
      'The app quits the way its quit key does, so panes are killed, their transcripts written, and the ' +
      'socket and discovery file released before this returns. Panes in the pane host (Keep Agents Running) ' +
      'are left running; `teamree host stop` ends them. Refused while a file in the app has unsaved ' +
      'edits or an agent is working, unless --force.\n\n' +
      "Returns once the endpoint is gone and the app's process has exited. Exit code 3 when no app is " +
      'running, 1 when one was asked and was still quitting when the wait ran out.',
    flags: [
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Give up waiting after this long. Defaults to ${DEFAULT_QUIT_TIMEOUT_MS}.`
      },
      {
        name: 'force',
        kind: 'boolean',
        description: 'Quit even with unsaved files or working agents; the edits come back when it next opens.'
      }
    ],
    examples: ['teamree quit', 'teamree quit --json', 'teamree quit --force'],
    run: async (context) => {
      const timeoutMs = readNumber(context.flags, 'timeout-ms') ?? DEFAULT_QUIT_TIMEOUT_MS
      const endpoint = context.client.endpoint
      // Asked first: the reply to the quit can be lost with the connection, and the pid is the proof it went.
      const { pid } = await context.client.call('status.get', {})

      let kept = 0
      try {
        const answer = await context.client.call('app.quit', readBoolean(context.flags, 'force') ? { force: true } : {})
        kept = answer.kept ?? 0
      } catch (error) {
        // The quit takes the connection the reply was travelling on; the
        // endpoint and the pid below are the better evidence.
        if (!(error instanceof CliError) || !LEAVING.has(error.code)) throw error
      }

      const outcome = await waitForAppGone({ endpoint, pid, timeoutMs })
      if (!outcome.gone) {
        throw new CliError({
          code: 'quit_timeout',
          message: outcome.endpointGone
            ? `The app is still quitting: pid ${pid} had not exited after ${timeoutMs}ms.`
            : `The app was asked to quit, but ${endpoint} was still there after ${timeoutMs}ms.`,
          exitCode: ExitCode.Failure,
          hint: 'A pane refusing to die holds the teardown. Raise --timeout-ms, or check the app.',
          data: { pid, endpoint, timeoutMs, endpointGone: outcome.endpointGone }
        })
      }

      return {
        data: { quit: true, pid, endpoint, waitedMs: outcome.waitedMs, kept },
        text: formatFields([
          ['pid', String(pid)],
          ['endpoint', endpoint],
          ['gone after', outcome.waitedMs === null ? 'unwatched (named pipe)' : `${outcome.waitedMs}ms`],
          ...(kept === 0 ? [] : [['kept running', `${panes(kept)} in the pane host`] as [string, string]])
        ])
      }
    }
  }
]
