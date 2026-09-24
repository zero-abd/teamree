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
  /** What is asked, read off the written rows above the hint; null falls back to the nearest row ending in `?`. */
  asks?: (above: readonly string[]) => string | null
}

export const SCREEN_RULES: readonly ScreenRule[] = [
  {
    agent: 'claude',
    matches: /^Enter to confirm · Esc to cancel/u,
    asks: (above) => (above.some((row) => row.trim() === 'Accessing workspace:') ? 'Trust this folder?' : null)
  },
  { agent: 'claude', matches: /^Esc to cancel · Tab to amend/u, asks: (above) => commandUnder(above, 'Bash command') },
  {
    agent: 'codex',
    matches: /^Press enter to continue/u,
    asks: (above) =>
      above.some((row) => row.trim().startsWith('Do you trust the contents of this directory?'))
        ? 'Trust this directory?'
        : null
  },
  {
    agent: 'codex',
    matches: /^Press enter to confirm or esc to cancel/u,
    asks: (above) => commandUnder(above, 'Would you like to run the following command?')
  }
]

/** How many written rows from the bottom a hint may sit: an idle agent's composer and footer fill at least this many. */
export const SCREEN_ROWS_ASKED = 2

/** What the last rows of this pane's screen say, or null when they say nothing this file can read. */
export function screenOpinion(agent: AgentKind | undefined, rows: readonly string[]): ScreenOpinion | null {
  return askedAt(agent, rows) === null ? null : 'waiting'
}

/** The question a screen that reads as asking is asking, or null; never one of its answers or its key hint. */
export function screenQuestion(agent: AgentKind | undefined, rows: readonly string[]): string | null {
  const asked = askedAt(agent, rows)
  if (asked === null) return null
  const above = dialogAbove(asked.written, asked.index)
  return asked.rule.asks?.(above) ?? nearestQuestion(above)
}

function askedAt(
  agent: AgentKind | undefined,
  rows: readonly string[]
): { rule: ScreenRule; written: string[]; index: number } | null {
  if (agent === undefined) return null
  const written = rows.filter((row) => row.trim().length > 0)
  for (let index = written.length - 1; index >= Math.max(0, written.length - SCREEN_ROWS_ASKED); index--) {
    const row = (written[index] ?? '').trim()
    const rule = SCREEN_RULES.find((candidate) => candidate.agent === agent && candidate.matches.test(row))
    if (rule !== undefined) return { rule, written, index }
  }
  return null
}

/** How far above its hint a dialog can start, when no rule across the screen marks its top. */
const DIALOG_ROWS = 40

function dialogAbove(written: readonly string[], hint: number): string[] {
  const above = written.slice(Math.max(0, hint - DIALOG_ROWS), hint)
  const top = above.findLastIndex((row) => /^\s*─{8,}\s*$/u.test(row))
  return above.slice(top + 1)
}

const MENU_OPTION = /^[❯›>]?\s*\d+\.\s/u

/** How many written rows from the bottom a menu's last option may sit: a wrapped option, then a hint. */
const MENU_ROWS_ASKED = 3

/** The question above a numbered menu at the bottom of the screen, for a dialog drawn without a known hint. */
export function menuQuestion(rows: readonly string[]): string | null {
  const written = rows.filter((row) => row.trim().length > 0)
  for (let index = written.length - 1; index >= Math.max(0, written.length - MENU_ROWS_ASKED); index--) {
    if (MENU_OPTION.test((written[index] ?? '').trim())) return nearestQuestion(dialogAbove(written, index))
  }
  return null
}

/** Whether a line is one of a dialog's answers or its key hint, which quoted alone reads as an answer given. */
export function isAnswerOrHint(line: string): boolean {
  const row = line.trim()
  if (MENU_OPTION.test(row) || SCREEN_RULES.some((rule) => rule.matches.test(row))) return true
  return /^(?:press\s+)?(?:esc|enter|tab|shift\+tab)\b.*\bto\s/iu.test(row)
}

/** What an agent's Notification hook message asks, shortened: `Permission to use Edit`. */
export function hookQuestion(message: string | undefined): string | null {
  const said = message?.trim() ?? ''
  if (said === '') return null
  const tool = /\bneeds your permission to use (.+?)\.?$/u.exec(said)?.[1]
  return tool === undefined ? said : `Permission to use ${tool}`
}

function nearestQuestion(above: readonly string[]): string | null {
  const row = above.findLast((candidate) => !MENU_OPTION.test(candidate.trim()) && candidate.trim().endsWith('?'))
  return row === undefined ? null : row.trim()
}

/** `Allow command: <cmd>?`, the command being the first row under `heading` indented past it, `$ ` dropped. */
function commandUnder(above: readonly string[], heading: string): string | null {
  const at = above.findIndex((row) => row.trim() === heading)
  if (at === -1) return null
  const indent = (above[at] ?? '').search(/\S/u)
  const command = above.slice(at + 1).find((row) => row.search(/\S/u) > indent || row.trim().startsWith('$ '))
  return command === undefined ? null : `Allow command: ${command.trim().replace(/^\$ /u, '')}?`
}
