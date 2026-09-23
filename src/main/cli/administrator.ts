// Running one command with an administrator password, on macOS, via
// `osascript -e 'do shell script "…" with administrator privileges'`. The
// command crosses two parsers — AppleScript's string literal, then /bin/sh —
// so a path is single-quoted for the shell and the whole escaped for AppleScript.

import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { conflict } from '../runtime/runtimeError'

/** osascript's exit for the Cancel button, and it is the same for every dialog. */
const USER_CANCELLED = '-128'

/** One argument, spelled so /bin/sh reads it back exactly. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** One AppleScript string literal; a literal cannot span lines. */
export function appleScriptString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  return `"${escaped}"`
}

/**
 * The command that makes the link. `mkdir -p`: `/usr/local/bin` may not exist.
 * `-n`: a destination that is itself a symlink to a directory is replaced, not written inside.
 */
export function linkCommand(source: string, destination: string): string {
  return (
    `/bin/mkdir -p ${shellQuote(dirname(destination))} && ` +
    `/bin/ln -sfn ${shellQuote(source)} ${shellQuote(destination)}`
  )
}

/** The one line of AppleScript that puts the password dialog on the screen. */
export function administratorScript(command: string): string {
  return `do shell script ${appleScriptString(command)} with administrator privileges`
}

/** Runs a command as an administrator, or says why it did not. */
export type AdministratorRunner = (command: string) => Promise<void>

/** The one call out of the process, so a test can stand in for it without a Mac. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export function createAdministratorRunner(exec: ExecFile = execFile): AdministratorRunner {
  return (command) =>
    new Promise<void>((resolve, reject) => {
      exec('/usr/bin/osascript', ['-e', administratorScript(command)], (error, _stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }
        const detail = stderr.trim() || error.message
        // Cancelling is a decision, not a fault.
        reject(
          detail.includes(USER_CANCELLED)
            ? conflict('The administrator password was not given, so nothing was changed.')
            : conflict(`macOS refused to run the command as an administrator: ${detail}`)
        )
      })
    })
}
