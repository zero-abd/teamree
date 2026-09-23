// Opening a checkout in the editor, terminal or Finder somebody actually has.
// Apps are found by bundle id without starting them; nothing builds a command
// line (a checkout called `$(rm -rf ~)` is a legal directory).

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { loginShellPath } from '../terminals/shell-environment'

export type AppKind = 'editor' | 'terminal' | 'finder'

export type KnownApp = { bundleId: string; label: string; kind: AppKind; file: string; cli?: string }

/** Every app teamree looks for: editors in the order it prefers them, then terminals, then Finder. */
export const KNOWN_APPS: readonly KnownApp[] = [
  { bundleId: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor', file: 'Visual Studio Code.app', cli: 'code' },
  { bundleId: 'com.todesktop.230313mzl4w4u92', label: 'Cursor', kind: 'editor', file: 'Cursor.app', cli: 'cursor' },
  { bundleId: 'dev.zed.Zed', label: 'Zed', kind: 'editor', file: 'Zed.app', cli: 'zed' },
  {
    bundleId: 'com.jetbrains.intellij',
    label: 'IntelliJ IDEA',
    kind: 'editor',
    file: 'IntelliJ IDEA.app',
    cli: 'idea'
  },
  { bundleId: 'com.jetbrains.intellij.ce', label: 'IntelliJ IDEA CE', kind: 'editor', file: 'IntelliJ IDEA CE.app' },
  { bundleId: 'com.jetbrains.WebStorm', label: 'WebStorm', kind: 'editor', file: 'WebStorm.app', cli: 'webstorm' },
  { bundleId: 'com.sublimetext.4', label: 'Sublime Text', kind: 'editor', file: 'Sublime Text.app', cli: 'subl' },
  { bundleId: 'com.apple.dt.Xcode', label: 'Xcode', kind: 'editor', file: 'Xcode.app' },
  { bundleId: 'com.mitchellh.ghostty', label: 'Ghostty', kind: 'terminal', file: 'Ghostty.app' },
  { bundleId: 'com.googlecode.iterm2', label: 'iTerm', kind: 'terminal', file: 'iTerm.app' },
  { bundleId: 'dev.warp.Warp-Stable', label: 'Warp', kind: 'terminal', file: 'Warp.app' },
  { bundleId: 'com.apple.Terminal', label: 'Terminal', kind: 'terminal', file: 'Terminal.app' },
  { bundleId: 'com.apple.finder', label: 'Finder', kind: 'finder', file: 'Finder.app' }
]

/** One thing the Open in menu offers. `command` is a bundle id, or a program name on PATH. */
export type OpenTarget = { command: string; label: string; kind: AppKind }

/** What the renderer is told about an open. A refusal is a value, as in `reveal/revealPath.ts`. */
export type EditorOpenResult = { opened: true; editor: string } | { opened: false; reason: string }

export type EditorDeps = {
  /** Where each known app is installed, by bundle id. Injected so no test asks Spotlight. */
  findApps?: (apps: readonly KnownApp[]) => Promise<Map<string, string>>
  /** Where a program of this name is on PATH, or null. */
  locate?: (command: string) => string | null
  isDirectory?: (path: string) => boolean
  /** Starts the program. Injected so no test opens a window. */
  start?: (binary: string, args: readonly string[]) => void
}

export type EditorActions = {
  list: () => Promise<{ editors: OpenTarget[] }>
  open: (params: { path: string; command?: string }) => Promise<EditorOpenResult>
}

type Found = OpenTarget & { app?: string; binary?: string; cli?: string }

export function createEditorActions(deps: EditorDeps = {}): EditorActions {
  const findApps = deps.findApps ?? findInstalledApps
  const locate = deps.locate ?? locateOnPath
  const isDirectory = deps.isDirectory ?? isDirectoryOnDisk
  const start = deps.start ?? startDetached

  // Once per run, as the renderer asks: Spotlight and PATH do not change under a menu.
  let found: Promise<Found[]> | null = null
  const detect = (): Promise<Found[]> => (found ??= detectAll(findApps, locate))

  const launch = (target: Found, path: string): EditorOpenResult => {
    // A terminal handed a file runs it.
    if (target.kind !== 'editor' && !isDirectory(path)) {
      return { opened: false, reason: `${target.label} opens folders only` }
    }
    try {
      if (target.app !== undefined) start('/usr/bin/open', ['-a', target.app, path])
      else if (target.binary !== undefined) start(target.binary, [path])
    } catch (error) {
      return { opened: false, reason: `${target.label} would not start: ${describe(error)}` }
    }
    return { opened: true, editor: target.label }
  }

  return {
    list: async () => ({
      editors: (await detect()).map(({ command, label, kind }) => ({ command, label, kind }))
    }),

    open: async ({ path, command }) => {
      // A relative path would resolve against wherever the app was launched from.
      if (!isAbsolute(path)) {
        return {
          opened: false,
          reason: `teamree can only open a full path in an editor, and ${path} is a relative one.`
        }
      }

      const targets = await detect()
      const named = command?.trim() ?? ''
      if (named.length === 0) {
        const editor = targets.find((target) => target.kind === 'editor')
        return editor === undefined ? { opened: false, reason: 'no editor found' } : launch(editor, path)
      }

      const listed = targets.find((target) => target.command === named)
      if (listed !== undefined) return launch(listed, path)
      const binary = locate(named)
      if (binary !== null) return launch({ command: named, label: labelFor(named), kind: 'editor', binary }, path)
      // A project that named a shim before apps were detected, on a Mac without the shim.
      const app = targets.find((target) => target.cli === named)
      return app === undefined ? { opened: false, reason: `${named} not found` } : launch(app, path)
    }
  }
}

/** Each known app as an app, else as its shim on PATH, in `KNOWN_APPS` order. */
async function detectAll(
  findApps: (apps: readonly KnownApp[]) => Promise<Map<string, string>>,
  locate: (command: string) => string | null
): Promise<Found[]> {
  const apps = await findApps(KNOWN_APPS).catch(() => new Map<string, string>())
  const found: Found[] = []
  for (const { bundleId, label, kind, cli } of KNOWN_APPS) {
    const app = apps.get(bundleId)
    const binary = app === undefined && cli !== undefined ? locate(cli) : null
    if (app !== undefined) found.push({ command: bundleId, label, kind, app, ...(cli === undefined ? {} : { cli }) })
    else if (binary !== null && cli !== undefined) found.push({ command: cli, label, kind, binary, cli })
  }
  return found
}

/** The folders apps live in, the ones Apple ships included. */
function appFolders(home: string): string[] {
  return [
    '/Applications',
    join(home, 'Applications'),
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Library/CoreServices'
  ]
}

export type MacLookup = {
  home: string
  exists: (path: string) => boolean
  /** `mdfind -attr kMDItemCFBundleIdentifier` output for these bundle ids. */
  spotlight: (bundleIds: readonly string[]) => Promise<string>
}

/** Bundle id to `.app` path: the usual folders first, then one Spotlight query for the rest. */
export async function findAppsOnMac(apps: readonly KnownApp[], lookup: MacLookup): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const app of apps) {
    const path = appFolders(lookup.home)
      .map((folder) => join(folder, app.file))
      .find((candidate) => lookup.exists(candidate))
    if (path !== undefined) found.set(app.bundleId, path)
  }

  const missing = apps.filter((app) => !found.has(app.bundleId)).map((app) => app.bundleId)
  if (missing.length === 0) return found
  let output = ''
  try {
    output = await lookup.spotlight(missing)
  } catch {
    return found
  }
  for (const line of output.split('\n')) {
    const match = /^(\/.+?\.app)\s+kMDItemCFBundleIdentifier = (\S+)$/.exec(line.trim())
    if (match === null) continue
    const [, path = '', bundleId = ''] = match
    // Spotlight also indexes the Trash and apps bundled inside other apps.
    if (path.includes('/.Trash/') || path.slice(0, -4).includes('.app/')) continue
    if (missing.includes(bundleId) && !found.has(bundleId)) found.set(bundleId, path)
  }
  return found
}

function findInstalledApps(apps: readonly KnownApp[]): Promise<Map<string, string>> {
  if (process.platform !== 'darwin') return Promise.resolve(new Map())
  return findAppsOnMac(apps, { home: homedir(), exists: existsSync, spotlight: askSpotlight })
}

/** A metadata query: reads the index, launches nothing. */
function askSpotlight(bundleIds: readonly string[]): Promise<string> {
  const query = bundleIds.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(' || ')
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/mdfind', ['-attr', 'kMDItemCFBundleIdentifier', query], { timeout: 3000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}

/** What to call a program somebody named themselves: the program, not the path. */
function labelFor(command: string): string {
  const known = KNOWN_APPS.find((app) => app.cli === command)
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

function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Starts the program and forgets it. Detached, so quitting teamree does not
 * close it; output ignored, since a pipe nobody reads eventually blocks it.
 */
function startDetached(binary: string, args: readonly string[]): void {
  spawn(binary, [...args], { detached: true, stdio: 'ignore' }).unref()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
