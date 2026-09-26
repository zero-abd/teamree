// The obvious setup command for a checkout, read off its lockfile, and the commands its Run buttons
// would start, read off its manifests. Only ever suggested: nothing here runs them.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunCommands, WorktreeSetupCheck } from '../../shared/entities'

/** A command, and the directory it fills that says it has run. */
export type SetupSuggestion = { command: string; installs?: string }

// First match wins: a lockfile over a bare package.json, JavaScript over the rest.
const RULES: ReadonlyArray<{ files: readonly string[]; suggestion: SetupSuggestion }> = [
  { files: ['pnpm-lock.yaml'], suggestion: { command: 'pnpm install --frozen-lockfile', installs: 'node_modules' } },
  { files: ['yarn.lock'], suggestion: { command: 'yarn install --immutable', installs: 'node_modules' } },
  { files: ['bun.lock', 'bun.lockb'], suggestion: { command: 'bun install', installs: 'node_modules' } },
  { files: ['package-lock.json'], suggestion: { command: 'npm ci', installs: 'node_modules' } },
  { files: ['package.json'], suggestion: { command: 'npm install', installs: 'node_modules' } },
  { files: ['uv.lock'], suggestion: { command: 'uv sync', installs: '.venv' } },
  { files: ['Gemfile.lock'], suggestion: { command: 'bundle install' } }
]

/** The suggestion for a checkout whose top level holds these names, if any. */
export function detectSetup(names: ReadonlySet<string>): SetupSuggestion | undefined {
  return RULES.find((rule) => rule.files.some((file) => names.has(file)))?.suggestion
}

/** What a checkout's lockfile suggests, and what it lacks for it; empty when unreadable. */
export async function checkSetup(dir: string): Promise<WorktreeSetupCheck> {
  let names: Set<string>
  try {
    names = new Set(await readdir(dir))
  } catch {
    return {}
  }
  const suggestion = detectSetup(names)
  if (suggestion === undefined) return {}
  const { command, installs } = suggestion
  return installs === undefined || names.has(installs) ? { command } : { command, missing: installs }
}

/** What `detectRun` reads beyond the names: `package.json`'s scripts and the Makefile's text. */
export type RunManifests = { scripts?: Readonly<Record<string, unknown>>; makefile?: string }

// The runner a lockfile implies; bun's `bun test` is its own test runner, not the script.
const SCRIPT_RUNNERS: ReadonlyArray<{ files: readonly string[]; run: (script: string) => string }> = [
  { files: ['pnpm-lock.yaml'], run: (script) => `pnpm ${script}` },
  { files: ['yarn.lock'], run: (script) => `yarn ${script}` },
  { files: ['bun.lock', 'bun.lockb'], run: (script) => `bun run ${script}` },
  { files: [], run: (script) => (script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`) }
]

// What `npm init` writes when there are no tests.
const NO_TESTS = /no test specified/

const TEST_RULES: ReadonlyArray<{ files: readonly string[]; command: string }> = [
  { files: ['Cargo.toml'], command: 'cargo test' },
  { files: ['go.mod'], command: 'go test ./...' },
  { files: ['uv.lock'], command: 'uv run pytest' }
]

/** Dev and test commands for a checkout whose top level holds these names; first match wins per kind. */
export function detectRun(names: ReadonlySet<string>, manifests: RunManifests): RunCommands {
  const scripts = names.has('package.json') ? (manifests.scripts ?? {}) : {}
  const has = (script: string): boolean => typeof scripts[script] === 'string' && scripts[script] !== ''
  const runner = SCRIPT_RUNNERS.find((rule) => rule.files.length === 0 || rule.files.some((file) => names.has(file)))
  const script = (name: string): string => runner?.run(name) ?? `npm run ${name}`
  const targets = makeTargets(manifests.makefile)
  const run: RunCommands = {}

  const dev = has('dev') ? script('dev') : has('start') ? script('start') : undefined
  const devTarget = ['dev', 'run', 'serve'].find((target) => targets.has(target))
  if (dev !== undefined) run.dev = dev
  else if (devTarget !== undefined) run.dev = `make ${devTarget}`

  if (has('test') && !NO_TESTS.test(String(scripts.test))) run.test = script('test')
  else if (targets.has('test')) run.test = 'make test'
  else {
    const rule = TEST_RULES.find((entry) => entry.files.some((file) => names.has(file)))
    if (rule !== undefined) run.test = rule.command
  }
  return run
}

/** Targets defined at the start of a line: `test:` and `test: build`, not `TEST := 1`. */
function makeTargets(makefile: string | undefined): Set<string> {
  const targets = new Set<string>()
  for (const match of (makefile ?? '').matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(match[1] as string)
  return targets
}

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']

/** What a checkout's manifests suggest for Run Dev and Run Tests; empty when unreadable. */
export async function checkRun(dir: string): Promise<RunCommands> {
  let names: Set<string>
  try {
    names = new Set(await readdir(dir))
  } catch {
    return {}
  }
  const read = (name: string): Promise<string | undefined> =>
    readFile(path.join(dir, name), 'utf8').catch(() => undefined)
  const manifests: RunManifests = {}
  if (names.has('package.json')) {
    try {
      const parsed: unknown = JSON.parse((await read('package.json')) ?? '')
      const scripts = (parsed as { scripts?: unknown } | null)?.scripts
      if (typeof scripts === 'object' && scripts !== null) manifests.scripts = scripts as Record<string, unknown>
    } catch {
      // A package.json mid-edit suggests nothing, rather than `npm test` for scripts it may not have.
      names.delete('package.json')
    }
  }
  const makefile = MAKEFILES.find((name) => names.has(name))
  if (makefile !== undefined) {
    const text = await read(makefile)
    if (text !== undefined) manifests.makefile = text
  }
  return detectRun(names, manifests)
}
