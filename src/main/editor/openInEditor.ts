// Opening a checkout in the editor somebody actually uses. Probes PATH rather
// than shipping a list; never builds a command line (a checkout called
// `$(rm -rf ~)` is a legal directory), so the free-text command is one program name.

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loginShellPath } from '../terminals/shell-environment'

/**
 * The editors teamree looks for, in the order it prefers them. Each is the
 * command the editor itself installs; anything else is one field away in Settings.
 */
export const KNOWN_EDITORS = [
  { command: 'code', label: 'VS Code' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'zed', label: 'Zed' },
  { command: 'idea', label: 'IntelliJ IDEA' },
  { command: 'subl', label: 'Sublime Text' }
] as const

export type KnownEditor = { command: string; label: string }

/** What the renderer is told about an open. A refusal is a value, as in `reveal/revealPath.ts`. */
export type EditorOpenResult = { opened: true; editor: string } | { opened: false; reason: string }

export type EditorDeps = {
  /** Where a program of this name is on this machine, or null. Injected for tests. */
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
      // A relative path would resolve against wherever the app was launched from.
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

      // A throw from the OS becomes a refusal rather than an exception crossing the bridge.
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
 * Which program to run: the one this project names, or the first one found. A
 * configured command is resolved, so a typo is a reason rather than an ENOENT.
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
 * Where a program of this name is, resolved the way a shell would. Against the
 * login shell's PATH: a Dock-launched app is handed none of what a profile adds.
 */
function locateOnPath(command: string): string | null {
  if (command.includes('/')) return canExecute(command) ? command : null
  const pathValue = loginShellPath({ platform: process.platform }) ?? process.env.PATH ?? ''
  for (const directory of pathValue.split(':').map((entry) => entry.trim())) {
    // An empty entry means the current directory on some shells.
    if (directory.length === 0) continue
    const candidate = join(directory, command)
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
 * Starts the editor and forgets it. Detached, so quitting teamree does not
 * close it; output ignored, since a pipe nobody reads eventually blocks it.
 */
function startDetached(binary: string, args: readonly string[]): void {
  spawn(binary, [...args], { detached: true, stdio: 'ignore' }).unref()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
