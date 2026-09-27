// Entry of the detached pane host (`out/main/paneHost.js`), run by the app as Electron in node mode:
//   paneHost.js --socket <path> --token <path> --log <path> --version <app version>

import { appendFileSync } from 'node:fs'
import { startPaneHost } from './paneHost/host'

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (value === undefined || value === '') {
    console.error(`paneHost: --${name} is required`)
    process.exit(2)
  }
  return value
}

const logPath = argument('log')
const log = (line: string): void => {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 })
  } catch {
    // Logging must never be what ends the host.
  }
}

// Its stdio is ignored: a stray SIGPIPE or hangup from the app's terminal must not end it.
process.on('SIGHUP', () => log('ignored SIGHUP'))
process.on('SIGPIPE', () => {})
// Logged and ended, never a dialog: node mode has none, and a host in an unknown state must not linger.
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error.stack ?? String(error)}`)
  process.exit(1)
})

startPaneHost({
  socket: argument('socket'),
  token: argument('token'),
  hostVersion: argument('version'),
  log,
  onClosed: () => process.exit(0)
}).catch((error: unknown) => {
  log(`could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
