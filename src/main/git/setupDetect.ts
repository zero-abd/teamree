// The obvious setup command for a checkout, read off its lockfile. Only ever
// suggested: nothing here runs it.

import { readdir } from 'node:fs/promises'
import type { WorktreeSetupCheck } from '../../shared/entities'

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
