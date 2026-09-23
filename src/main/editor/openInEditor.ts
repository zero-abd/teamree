// Opening a checkout in the editor somebody actually uses, and refusing to when
// there is nothing to open it with.
//
// The sidebar's row menu offers one "Open in …" item, and everything hard about
// it is here rather than there. Two decisions are worth writing down.
//
// The first is that this probes PATH rather than shipping a list of
// applications. `agent-discovery.ts` made the same argument for agents and it
// holds here: a list somebody has to fill in goes stale the first time they
// install something, and the answer is already in PATH. The free-text command
// in Settings is the escape hatch for the editor this short list has never
// heard of, not the ordinary way in.
//
// The second is that nothing here builds a command line. The path is an
// argument in an argv, never text interpolated into a shell, because the thing
// being interpolated would be a directory name from somebody's disk and a
// checkout called `$(rm -rf ~)` is a legal directory. There is no shell in this
// module at all, which is why the free-text command is treated as the name of
// one program rather than parsed into a program and its flags: parsing is where
// quoting gets reinvented, and reinvented quoting is where this would go wrong.
//
// Nothing here imports electron, and the two things that touch the machine —
// finding a program and starting one — are injected, so the whole decision is
// testable in a plain vitest worker without ever launching an editor.

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loginShellPath } from '../terminals/shell-environment'

/**
 * The editors teamree looks for, in the order it prefers them.
 *
 * Short on purpose. Every name here is a command these editors install
 * themselves and document as the way to open a directory from a terminal, so a
 * hit means the user set that up. Anything else is one field away in Settings.
 */
export const KNOWN_EDITORS = [
  { command: 'code', label: 'VS Code' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'zed', label: 'Zed' },
  { command: 'idea', label: 'IntelliJ IDEA' },
  { command: 'subl', label: 'Sublime Text' }
] as const

export type KnownEditor = { command: string; label: string }

/**
 * What the renderer is told about an open.
 *
 * A refusal is a value rather than a thrown error, for the same reason
 * `reveal/revealPath.ts` makes it one: the caller is a menu item, and a menu
 * item that was told why nothing happened can say so.
 */
export type EditorOpenResult = { opened: true; editor: string } | { opened: false; reason: string }

export type EditorDeps = {
  /**
   * Where a program of this name is on this machine, or null. Injected so no
   * test depends on what happens to be installed on the machine running it.
   */
  locate?: (command: string) => string | null
  /** Starts the editor. Injected so no test opens a window. */
  start?: (binary: string, args: readonly string[]) => void
}

export type EditorActions = {
  list: () => { editors: KnownEditor[] }
  open: (params: { path: string; command?: string }) => EditorOpenResult
}

export function createEditorActions(deps: EditorDeps = {}): EditorActions {
  const locate = deps.locate ?? locateOnPath
  const start = deps.start ?? startDetached

  return {
    list: () => ({
      editors: KNOWN_EDITORS.filter((editor) => locate(editor.command) !== null).map((editor) => ({ ...editor }))
    }),

    open: ({ path, command }) => {
      // A relative path would be resolved against this process's working
      // directory, which is wherever the app was launched from and has nothing
      // to do with any checkout. The same check `revealPath` makes, for the
      // same reason.
      if (!isAbsolute(path)) {
        return {
          opened: false,
          reason: `teamree can only open a full path in an editor, and ${path} is a relative one.`
        }
      }

      const chosen = choose(command, locate)
      if (chosen === null) {
        return {
          opened: false,
          reason:
            command === undefined || command.trim().length === 0
              ? `teamree found no editor on PATH. Looked for ${KNOWN_EDITORS.map((editor) => editor.command).join(', ')}; name yours in Settings.`
              : `teamree could not find ${command.trim()} on PATH.`
        }
      }

      // A throw from the OS is the same question being answered — did an editor
      // come up? — so it becomes a refusal carrying what went wrong rather than
      // an exception crossing the bridge.
      try {
        start(chosen.binary, [path])
      } catch (error) {
        return { opened: false, reason: `${chosen.label} would not start: ${describe(error)}` }
      }
      return { opened: true, editor: chosen.label }
    }
  }
}

/**
 * Which program to run: the one this project names, or the first one found.
 *
 * A configured command is resolved rather than trusted. Handing an unresolved
 * name to the spawner would turn a typo into an ENOENT the user reads as the
 * editor being broken, and this module exists to answer with a reason instead.
 */
function choose(
  command: string | undefined,
  locate: (command: string) => string | null
): { binary: string; label: string } | null {
  const named = command?.trim() ?? ''
  if (named.length > 0) {
    const binary = locate(named)
    return binary === null ? null : { binary, label: labelFor(named) }
  }
  for (const editor of KNOWN_EDITORS) {
    const binary = locate(editor.command)
    if (binary !== null) return { binary, label: editor.label }
  }
  return null
}

/** What to call an editor somebody named themselves: the program, not the path. */
function labelFor(command: string): string {
  const known = KNOWN_EDITORS.find((editor) => editor.command === command)
  if (known) return known.label
  return command.split('/').filter(Boolean).pop() ?? command
}

/**
 * Where a program of this name is, resolved the way a shell would resolve it.
 *
 * Against the login shell's PATH rather than this process's, which is the whole
 * of `agent-discovery.ts`'s argument repeated: an app opened from the Dock is
 * handed `/usr/bin:/bin:/usr/sbin:/sbin` and nothing a profile adds, so an
 * editor under /opt/homebrew/bin would be missing from the app and present in
 * every terminal on the same machine.
 */
function locateOnPath(command: string): string | null {
  if (command.includes('/')) return canExecute(command) ? command : null
  const pathValue = loginShellPath({ platform: process.platform }) ?? process.env.PATH ?? ''
  for (const directory of pathValue.split(':').map((entry) => entry.trim())) {
    // An empty entry means the current directory on some shells, which is not
    // somewhere to go looking for a program to run.
    if (directory.length === 0) continue
    const candidate = join(directory, command)
    // The first hit wins, the way a shell resolves it.
    if (canExecute(candidate)) return candidate
  }
  return null
}

function canExecute(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Starts the editor and forgets it.
 *
 * Detached with its output thrown away, because an editor is not this app's
 * child in any sense that matters: quitting teamree must not close the window
 * somebody is working in, and a pipe nobody reads is a program that eventually
 * blocks on its own stdout.
 */
function startDetached(binary: string, args: readonly string[]): void {
  spawn(binary, [...args], { detached: true, stdio: 'ignore' }).unref()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
