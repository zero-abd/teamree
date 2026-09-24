// What the bottom of an agent's screen says: a table of the key hints each binary
// draws under a question it is blocked on, quoted from a pty running the real
// binary. Unmatched is `null`, no opinion, never a denial.
//
// Observed 2026-09-23 at 100x30, TERM_PROGRAM set as `shell-environment.ts` sets it:
//   claude 2.1.280   "Enter to confirm · Esc to cancel"         folder trust, every new path
//                    "Esc to cancel · Tab to amend"             a tool call waiting on permission
//   codex 0.146.0    "Press enter to continue"                  folder trust, once per repo
//                    "Press enter to confirm or esc to cancel"  a command waiting on approval
// No hook has loaded at the trust prompt, it rings no bell and leaves the title alone.

import type { AgentKind } from './entities'

/** What a screen can be read as claiming. Never "working" or "idle": only a question is drawn this plainly. */
export type ScreenOpinion = 'waiting'

export type ScreenRule = {
  agent: AgentKind
  /** Tested against one row, trimmed; anchored at the start so a wrapped hint still matches. */
  matches: RegExp
}

export const SCREEN_RULES: readonly ScreenRule[] = [
  { agent: 'claude', matches: /^Enter to confirm · Esc to cancel/u },
  { agent: 'claude', matches: /^Esc to cancel · Tab to amend/u },
  { agent: 'codex', matches: /^Press enter to continue/u },
  { agent: 'codex', matches: /^Press enter to confirm or esc to cancel/u }
]

/** How many written rows from the bottom a hint may sit: an idle agent's composer and footer fill at least this many. */
export const SCREEN_ROWS_ASKED = 2

/** What the last rows of this pane's screen say, or null when they say nothing this file can read. */
export function screenOpinion(agent: AgentKind | undefined, rows: readonly string[]): ScreenOpinion | null {
  if (agent === undefined) return null
  const written = rows.map((row) => row.trim()).filter((row) => row.length > 0)
  const bottom = written.slice(-SCREEN_ROWS_ASKED)
  const rules = SCREEN_RULES.filter((rule) => rule.agent === agent)
  return bottom.some((row) => rules.some((rule) => rule.matches.test(row))) ? 'waiting' : null
}
