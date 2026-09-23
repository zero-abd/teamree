// What a pane's own window title says it is doing, when it says anything.
//
// Teamree watches a PTY, not an agent's protocol, so it cannot ask an agent
// what it is up to. But an agent that sets its window title has volunteered an
// answer, and that is different in kind from a guess: OSC 0/2 is the program
// speaking about itself, in bytes teamree already reads.
//
// The table is therefore a table of quotations, not of inferences. Each row
// says "this agent, writing a title of this shape, has said it is X", and every
// row was written down from a title that binary actually wrote, in a pty, on a
// dated run. Anything not matched is `null` — no opinion. `null` is never a
// denial: an agent that says nothing has not said it is idle, and a reader that
// treated silence as an answer would be inventing the thing this file exists to
// avoid inventing.
//
// What was observed, 2026-09-23, both agents run in a pty with TERM_PROGRAM
// set the way `shell-environment.ts` sets it:
//
//   claude 2.1.280   "✳ Claude Code"   idle at the composer
//                    "◐ Date command"  mid-turn, the two glyphs alternating
//                    "✳ Bash tool …"   WHILE ITS OWN PERMISSION PROMPT WAS UP
//   codex 0.146.0    "teamree"         idle; the title is the cwd's basename
//                    "⠏ teamree"       mid-turn, braille frames cycling
//
// The third line is the finding that shapes this file. Claude Code's title is
// the same while it is blocked on a question as it is when the turn is over, so
// no title here can be read as "waiting" — and the `waiting` arm below stays
// empty until some agent writes a title that earns it. The evidence for waiting
// comes from the other source teamree has bytes for, the bell.

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
 * One row per shape of title that an agent has been seen to write.
 *
 * Anchored at the start and requiring the space after the glyph, because the
 * part being read is a prefix the program prepends to a summary it also wrote:
 * a title that merely contains a spinner somewhere is a title about something
 * else. The summaries themselves are never matched on — they are the user's
 * words back at them, and they are free text.
 */
export const TITLE_RULES: readonly TitleRule[] = [
  // Claude Code's mid-turn title alternates the four rotations of a half-filled
  // circle. Its other glyph, ✳, is what it writes when no turn is running, and
  // it writes that whether the turn ended or is blocked on a prompt — so there
  // is no row for it.
  { agent: 'claude', matches: /^[◐◑◒◓] /u, says: 'working' },
  // Codex prefixes the directory's name with one frame of a braille spinner
  // while a turn is running, and writes the bare name the rest of the time.
  { agent: 'codex', matches: /^[⠀-⣿] /u, says: 'working' }
]

/**
 * What this pane's title says, or null when it says nothing this file knows how
 * to read — which is the answer for every agent with no row above, for a plain
 * shell, and for a title an agent wrote in a state nobody has watched it in.
 */
export function titleOpinion(agent: AgentKind | undefined, title: string): TitleOpinion | null {
  if (agent === undefined) return null
  for (const rule of TITLE_RULES) {
    if (rule.agent === agent && rule.matches.test(title)) return rule.says
  }
  return null
}
