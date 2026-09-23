// Ending the app from a shell. A signal is the wrong ending: the ptys, socket,
// discovery file and transcripts are released by `before-quit`, which only the
// app's own quit runs.

import { readNumber } from '../argv.js'
import type { CommandSpec } from '../command-spec.js'
import { CliError, ExitCode } from '../exit.js'
import { formatFields } from '../output.js'
import { DEFAULT_QUIT_TIMEOUT_MS, waitForEndpointGone } from '../waiting.js'

/** Failures that are as likely to be the app leaving as they are a fault. */
const LEAVING = new Set(['connection_lost', 'connection_closed'])

export const quitCommands: readonly CommandSpec[] = [
  {
    path: ['quit'],
    summary: 'Quit the running app, and wait until it has gone.',
    details:
      'The app quits the way its quit key does, so panes are killed, their transcripts written, and the ' +
      'socket and discovery file released before this returns.\n\n' +
      'Returns once the endpoint is gone, which is the last thing the teardown does. Exit code 3 when no ' +
      'app is running, 1 when one was asked and the endpoint was still there when the wait ran out.',
    flags: [
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Give up waiting after this long. Defaults to ${DEFAULT_QUIT_TIMEOUT_MS}.`
      }
    ],
    examples: ['teamree quit', 'teamree quit --json'],
    run: async (context) => {
      const timeoutMs = readNumber(context.flags, 'timeout-ms') ?? DEFAULT_QUIT_TIMEOUT_MS
      const endpoint = context.client.endpoint

      let pid: number | null = null
      try {
        pid = (await context.client.call('app.quit', {})).pid
      } catch (error) {
        // The quit takes the connection the reply was travelling on; the
        // endpoint below is the better evidence.
        if (!(error instanceof CliError) || !LEAVING.has(error.code)) throw error
      }

      const outcome = await waitForEndpointGone({ endpoint, timeoutMs })
      if (!outcome.gone) {
        throw new CliError({
          code: 'quit_timeout',
          message: `The app was asked to quit, but ${endpoint} was still there after ${timeoutMs}ms.`,
          exitCode: ExitCode.Failure,
          hint: 'A pane refusing to die holds the teardown. Raise --timeout-ms, or check the app.',
          data: { pid, endpoint, timeoutMs }
        })
      }

      return {
        data: { quit: true, pid, endpoint, waitedMs: outcome.waitedMs },
        text: formatFields([
          ['pid', pid === null ? '-' : String(pid)],
          ['endpoint', endpoint],
          ['gone after', outcome.waitedMs === null ? 'unwatched (named pipe)' : `${outcome.waitedMs}ms`]
        ])
      }
    }
  }
]
