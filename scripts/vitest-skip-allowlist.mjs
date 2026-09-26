// Fails the run on any skipped test not allowlisted here with a reason. A stubbed node-pty once took
// the suite from 7 to 67 skips and still exited 0; one check here cannot rot the way per-file ones do.

import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const onWindows = () => process.platform === 'win32'
const offMac = () => process.platform !== 'darwin'
const relayOptOut = () => process.env.TEAMREE_SKIP_RELAY_TESTS === '1'
const ptyOptOut = () => process.env.TEAMREE_SKIP_PTY_TESTS === '1'
const workerdOptOut = () => process.env.TEAMREE_SKIP_WORKERD_TESTS === '1'

/**
 * The accepted skips and why. `suite` covers a top-level describe, `test` one test, neither the file;
 * `when` is what must hold for the absence to be acceptable.
 */
const ALLOWED = [
  {
    file: 'src/main/teamwork/macWatchProbe.test.ts',
    why:
      'a diagnostic whose own first line says it asserts nothing. It spends a minute in ' +
      'sleeps to print what macOS does with fs.watch, and runs under TEAMREE_MAC_PROBE=1.'
  },
  {
    file: 'tests/platform/socket-endpoint.test.ts',
    test: 'rejects a path that is short in characters but long in bytes',
    why:
      'the kernel half of a sun_path check, on a filesystem that does not enforce the limit. ' +
      'The assertion that matters — that fitsUnixSocketPath rejects the path — runs before it.'
  },

  // Opted out by hand: require-test-environment.mjs refuses to start without relay and pty otherwise.
  {
    file: 'src/main/teamwork/peer/relayProcess.test.ts',
    suite: 'two peers over the real relay',
    when: relayOptOut,
    why: 'TEAMREE_SKIP_RELAY_TESTS=1: teamwork is proven here only against a fake.'
  },
  {
    file: 'src/main/teamwork/peer/relayWatch.test.ts',
    suite: 'watching a teammate’s pane over the real relay',
    when: () => relayOptOut() || ptyOptOut(),
    why: 'TEAMREE_SKIP_RELAY_TESTS=1 or TEAMREE_SKIP_PTY_TESTS=1: this suite needs both.'
  },
  {
    file: 'tests/teamwork/scenario.test.ts',
    suite: 'act II — across the relay',
    when: relayOptOut,
    why: 'TEAMREE_SKIP_RELAY_TESTS=1: the scenario stops after the local act.'
  },
  {
    file: 'tests/teamwork/task-details.test.ts',
    suite: 'teammates see the task',
    when: relayOptOut,
    why: 'TEAMREE_SKIP_RELAY_TESTS=1: task details are proven here only against a fake relay.'
  },
  {
    file: 'tests/teamwork/two-peers.test.ts',
    test: 'puts the two of them on a real relay and waits until they have met',
    when: relayOptOut,
    why: 'TEAMREE_SKIP_RELAY_TESTS=1: the two peers are never put on a relay.'
  },
  {
    file: 'src/main/terminals/pty-session.test.ts',
    suite: 'PtySession',
    when: () => ptyOptOut() || onWindows(),
    why: 'TEAMREE_SKIP_PTY_TESTS=1, or Windows, where PtySession is exercised by session-manager instead.'
  },
  {
    file: 'src/main/terminals/session-manager.test.ts',
    suite: 'terminal handlers',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: nothing here forks a real terminal.'
  },
  {
    file: 'src/main/terminals/agent-launch-arguments.test.ts',
    suite: 'the arguments a person always passes',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: where the arguments land is proven against no real launch.'
  },
  {
    file: 'src/main/terminals/session-restore.test.ts',
    suite: 'restoring terminals across a restart',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: restore is proven only against records, not against panes.'
  },
  {
    file: 'src/main/terminals/pty-tail.test.ts',
    suite: 'recoverTailOnTeardown',
    when: () => ptyOptOut() || onWindows(),
    why: 'TEAMREE_SKIP_PTY_TESTS=1, or Windows, which has no tail to recover.'
  },
  {
    file: 'src/main/runtime/terminalErrorCodes.test.ts',
    suite: 'terminal error codes over a real pty',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: the codes are checked on the wire but not against a pty.'
  },
  {
    file: 'src/main/runtime/terminalExitEvents.test.ts',
    suite: 'exits on the workspace stream',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: no pane exits, so no exit reaches the stream.'
  },
  {
    file: 'src/main/quitDuringStartup.test.ts',
    suite: 'quitting before the app has finished starting',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: no pane comes back from the last session, so no quit can race one.'
  },
  {
    file: 'src/main/runtime/workspaceSubscription.test.ts',
    suite: 'workspace stream terminal producers',
    when: ptyOptOut,
    why: 'TEAMREE_SKIP_PTY_TESTS=1: the other producers on that stream still run.'
  },
  {
    file: 'relay/test/workerd/pairing.workerd.test.ts',
    when: workerdOptOut,
    why:
      'TEAMREE_SKIP_WORKERD_TESTS=1: the Durable Object is covered only by the fake in ' +
      'relay/test/hibernation.test.ts. The workerd binary is a per-platform npm package; ' +
      '`cd relay && npm ci` is what installs it.'
  },
  {
    file: 'relay/test/workerd/deadlines.workerd.test.ts',
    when: workerdOptOut,
    why: 'TEAMREE_SKIP_WORKERD_TESTS=1: nothing in this run says the real runtime fires the alarm.'
  },
  {
    file: 'relay/test/workerd/configuration.workerd.test.ts',
    when: workerdOptOut,
    why:
      'TEAMREE_SKIP_WORKERD_TESTS=1: that a limit the Worker cannot parse refuses every request, ' +
      'rather than being quietly replaced by the default, is proven in this run only as far as ' +
      'configFromEnv throwing (relay/test/operability.test.ts).'
  },

  // macOS-only: the updater swaps .app bundles with macOS tools. CI runs the rest on Linux.
  {
    file: 'src/main/updates/installHelper.test.ts',
    suite: 'the install helper',
    when: offMac,
    why: 'not macOS: the helper validates and clears bundles with plutil and xattr.'
  },
  {
    file: 'src/main/updates/selfInstaller.test.ts',
    test: 'says macOS refused, with the way to Settings, when the bundle cannot be written',
    when: offMac,
    why: 'not macOS: the refusal is made with chflags uchg, which Linux lacks.'
  },
  {
    file: 'src/main/updates/selfInstall.integration.test.ts',
    suite: 'updating in place',
    when: offMac,
    why: 'not macOS: it signs, stages and swaps a real .app bundle.'
  },

  {
    file: 'src/main/terminals/shell-integration.test.ts',
    suite: 'the startup files',
    test: 'find the bundled CLI after every zsh startup file rebuilds PATH, reading the user’s files where their .zshenv moved them',
    when: offMac,
    why: 'not macOS: zsh is not on the Linux runner; the bash half of the same files runs there.'
  },
  {
    file: 'src/main/terminals/shell-integration.test.ts',
    suite: 'the startup files',
    test: 'keeps the history where the user’s shell keeps it',
    when: offMac,
    why: 'not macOS: zsh is not on the Linux runner.'
  },

  // POSIX-only; listed so a Windows run still reports exactly what it did not run.
  {
    file: 'src/main/terminals/shell-integration.test.ts',
    suite: 'the startup files',
    when: onWindows,
    why: 'Windows: panes there get the CLI on PATH from the environment alone.'
  },
  {
    file: 'src/main/terminals/session-manager.test.ts',
    suite: 'terminal handlers',
    test: 'finds this build’s CLI first on a pane’s PATH when run from a checkout',
    when: onWindows,
    why: 'Windows: the stand-in CLI is a POSIX script.'
  },
  {
    file: 'src/main/terminals/session-manager.test.ts',
    suite: 'terminal handlers',
    test: 'finds this build’s CLI first on a pane’s PATH when run from a packaged app',
    when: onWindows,
    why: 'Windows: the stand-in CLI is a POSIX script.'
  },
  {
    file: 'src/main/terminals/session-restore.test.ts',
    suite: 'restoring terminals across a restart',
    test: 'tells a restored pane the terminal id it had before',
    when: onWindows,
    why: 'Windows: the stand-in agent is a POSIX script.'
  },
  {
    file: 'src/main/runtime/socketServer.test.ts',
    when: onWindows,
    why: 'Windows: the runtime listens on a named pipe there, covered by the pipe tests.'
  },
  {
    file: 'src/main/terminals/shell-environment.test.ts',
    when: onWindows,
    why: 'Windows: the POSIX login-shell rules have no meaning there.'
  },
  {
    file: 'src/main/git/checkoutPathAvailability.test.ts',
    when: onWindows,
    why: 'Windows: the case-sensitivity these assert is the POSIX filesystem’s.'
  },
  {
    file: 'tests/platform/process-tree.test.ts',
    suite: 'the real POSIX process group',
    when: onWindows,
    why: 'Windows: process groups are killed through the job object instead.'
  },
  {
    file: 'tests/platform/socket-endpoint.test.ts',
    suite: 'the kernel underneath',
    when: onWindows,
    why: 'Windows: there is no sun_path to overrun.'
  }
]

/** Where a skipped test lives and what it is called, as the allowlist spells it. */
function describeSkip(testCase) {
  const file = relative(REPO_ROOT, testCase.module.moduleId).replaceAll('\\', '/')
  const path = testCase.fullName.split(' > ')
  return { file, suite: path[0], name: testCase.fullName, leaf: path.at(-1) }
}

function allowanceFor(skip) {
  return ALLOWED.find(
    (entry) =>
      entry.file === skip.file &&
      (entry.suite === undefined || entry.suite === skip.suite) &&
      (entry.test === undefined || entry.test === skip.leaf) &&
      (entry.when === undefined || entry.when())
  )
}

export default class SkipAllowlist {
  onTestRunEnd(testModules, _errors, reason) {
    // An interrupted or failing run has something more worth reading first.
    if (reason !== 'passed') return

    const unexplained = []
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        if (testCase.result().state !== 'skipped') continue
        const skip = describeSkip(testCase)
        if (allowanceFor(skip) === undefined) unexplained.push(skip)
      }
    }
    if (unexplained.length === 0) return

    console.error(
      [
        '',
        `skip-allowlist: ${unexplained.length} test(s) were skipped for a reason this project has not written down,`,
        'skip-allowlist: so this run proved less than its pass count says. They are:',
        '',
        ...unexplained.map((skip) => `  ${skip.file}  ${skip.name}`),
        '',
        'skip-allowlist: if these were meant to run, the usual causes are a relay that is not built',
        'skip-allowlist: (cd relay && npm run build), a node-pty that cannot fork (npm ci), or a missing',
        'skip-allowlist: workerd binary (cd relay && npm ci). If they were meant to be left out, say so',
        'skip-allowlist: by setting TEAMREE_SKIP_RELAY_TESTS=1, TEAMREE_SKIP_PTY_TESTS=1 or',
        'skip-allowlist: TEAMREE_SKIP_WORKERD_TESTS=1. If they are legitimately absent for some other',
        'skip-allowlist: reason, add them to ALLOWED in scripts/vitest-skip-allowlist.mjs with the reason,',
        'skip-allowlist: which is the only place in this project where a skip is allowed to be silent.',
        ''
      ].join('\n')
    )
    process.exitCode = 1
  }
}
