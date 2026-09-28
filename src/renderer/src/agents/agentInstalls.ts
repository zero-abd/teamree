// What to install on a machine with no coding agent: the most used harnesses with one command line each.

import type { AgentKind } from '@shared/entities'
import { HARNESSES } from './harnesses'

export type AgentInstall = { kind: AgentKind; command: string }

/** Claude Code and Codex first; each line installs onto PATH. */
export const AGENT_INSTALLS: readonly AgentInstall[] = [
  { kind: 'claude', command: 'npm install -g @anthropic-ai/claude-code' },
  { kind: 'codex', command: 'npm install -g @openai/codex' },
  { kind: 'gemini', command: 'npm install -g @google/gemini-cli' },
  { kind: 'opencode', command: 'npm install -g opencode-ai' }
]

/** Every other harness teamree finds and starts, by name, in catalogue order. */
export function otherHarnessNames(): string[] {
  const listed = new Set<string>(AGENT_INSTALLS.map((install) => install.kind))
  return Object.entries(HARNESSES)
    .filter(([kind]) => !listed.has(kind))
    .map(([, harness]) => harness.name)
}
