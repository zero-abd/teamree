// Running one command with an administrator password, on macOS.
//
// `osascript -e 'do shell script "…" with administrator privileges'` is the
// ordinary mechanism: it puts up the system password dialog, and nothing else
// in the app ever sees the password. What makes it worth its own module is the
// quoting, because the command crosses two parsers on its way to being run and
// the app's own path — the one variable in it — is a path a user chose:
//
//   1. AppleScript reads the text after `do shell script` as a string literal.
//   2. /bin/sh reads what that literal spells out as a command line.
//
// So a path is single-quoted for the shell (single quotes because `$` and a
// backtick mean nothing inside them, and a path is allowed to contain both),
// and the whole command is then escaped as an AppleScript literal. There is no
// third layer: the script reaches osascript as one argv entry, never through a
// shell.

import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { conflict } from '../runtime/runtimeError'

/** osascript's exit for the Cancel button, and it is the same for every dialog. */
const USER_CANCELLED = '-128'

/**
 * One argument, spelled so /bin/sh reads it back exactly.
 *
 * Single quotes suspend every expansion the shell has, which leaves one case to
 * handle: a single quote itself, which ends the run and has to be re-entered.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * One AppleScript string literal.
 *
 * The line breaks matter as much as the quotes: an AppleScript literal cannot
 * span lines, so a path containing one would be a syntax error rather than a
 * mis-read path.
 */
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
 * The command that makes the link, whether or not it ends up being run as an
 * administrator — the unprivileged path does the same work through `fs`, and
 * having one spelling of the intent keeps the two from drifting.
 *
 * `mkdir -p` because `/usr/local/bin` does not exist on a Mac that has never
 * had anything installed into it. `-n` on the link so that a destination which
 * is itself a symlink to a directory is replaced rather than written inside.
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

export function createAdministratorRunner(): AdministratorRunner {
  return (command) =>
    new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', administratorScript(command)], (error, _stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }
        const detail = stderr.trim() || error.message
        // Cancelling is a decision, not a fault, and the message has to read
        // like one: the user knows what they just pressed.
        reject(
          detail.includes(USER_CANCELLED)
            ? conflict('The administrator password was not given, so nothing was changed.')
            : conflict(`macOS refused to run the command as an administrator: ${detail}`)
        )
      })
    })
}
