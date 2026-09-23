// What a pane's window title (OSC 0/2) says the agent is doing: a table of
// quotations from titles each binary actually wrote, never inferences. Unmatched
// is `null`, no opinion, never a denial.
//
// Observed 2026-09-23 in a pty with TERM_PROGRAM set as `shell-environment.ts` sets it:
//   claude 2.1.280   "✳ Claude Code"   idle at the composer
//                    "◐ Date command"  mid-turn, the two glyphs alternating
//                    "✳ Bash tool …"   WHILE ITS OWN PERMISSION PROMPT WAS UP
//   codex 0.146.0    "teamree"         idle; the title is the cwd's basename
//                    "⠏ teamree"       mid-turn, braille frames cycling
// Claude Code's title is the same blocked on a question as when the turn is over,
// so no title reads as "waiting"; that evidence comes from the bell.

import type { AgentKind } from './entities'

/** What a title can be read as claiming. Never "idle": see above. */
export type TitleOpinion = 'waiting' | 'working'

export type TitleRule = {
  agent: AgentKind
  /** Tested against the title as the program wrote it, untrimmed. */
  matches: RegExp
  says: TitleOpinion
}

/**
 * One row per shape of title an agent has been seen to write. Anchored at the
 * start with the space after the glyph: the summary after it is free text and never matched.
 */
export const TITLE_RULES: readonly TitleRule[] = [
  // The four rotations of a half-filled circle; ✳ means no turn running, whether ended or blocked, so no row.
  { agent: 'claude', matches: /^[◐◑◒◓] /u, says: 'working' },
  // One frame of a braille spinner before the directory name while a turn runs.
  { agent: 'codex', matches: /^[⠀-⣿] /u, says: 'working' }
]

/** What this pane's title says, or null when it says nothing this file can read. */
export function titleOpinion(agent: AgentKind | undefined, title: string): TitleOpinion | null {
  if (agent === undefined) return null
  for (const rule of TITLE_RULES) {
    if (rule.agent === agent && rule.matches.test(title)) return rule.says
  }
  return null
}
