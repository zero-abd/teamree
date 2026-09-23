// Rewriting an agent's launch command so a session can be picked up again.
//
// Terminals do not survive the app quitting: a PTY is a child process, and
// killing the app kills it. But for a coding agent the shell was never the
// valuable part — the conversation was, and the agent already keeps that on
// disk under a session id of its own. So restoring an agent pane is not a
// matter of keeping a process alive across a restart. It is a matter of
// launching the same agent again and handing it back its session id.
//
// Two commands per pane, then. The one that starts a session pins the id we
// will want later; the one that restores it resumes that id. Everything here
// is about producing those two strings from whatever the user typed, without
// mangling the rest of their command.
//
// The whole module fails open. Anything it cannot model with certainty — an
// unfamiliar agent, a pipeline, an unterminated quote — comes back unchanged
// or with the selector simply appended, which is what would have happened if
// none of this existed.

import { randomUUID } from 'node:crypto'
import type { AgentKind } from '../../shared/entities'

export type { AgentKind }

/** One flag and whether a separate token follows it carrying its value. */
type Selector = { flag: string; takesValue: boolean }

type AgentSpec = {
  /** Executable names, as they appear in command position. */
  executables: readonly string[]
  /**
   * Argv that pins a chosen session id at launch. Absent when the CLI has no
   * such flag, which is the more common case: those agents mint their own id
   * and the only honest way to resume them is the directory-scoped form below.
   */
  pin?: (sessionId: string) => readonly string[]
  /** Argv that resumes a session by the id we pinned. */
  resume?: (sessionId: string) => readonly string[]
  /**
   * Argv that resumes the most recent session in this directory. Worth having
   * even where `resume` exists: a worktree is one task's checkout, so "the
   * last session here" is very nearly always the right one.
   */
  resumeLatest?: readonly string[]
  /**
   * What to strip from a stored command before appending our own selector, so
   * a stale locator can never compete with the authoritative one.
   */
  selectors: readonly Selector[]
  /**
   * Argv that hands the agent its first prompt at launch. Absent for an agent
   * whose CLI has no such form; it then starts bare and the task stays on the
   * worktree record. Goes on last, after every selector — for the two that
   * take it as a positional, anything after it would be more prompt.
   */
  prompt?: (text: string) => readonly string[]
}

const AGENTS: Readonly<Record<AgentKind, AgentSpec>> = {
  claude: {
    executables: ['claude'],
    // The one CLI here that lets the caller choose the id up front. That is
    // worth a lot: every other agent has to be asked afterwards what id it
    // picked, and an agent that is asked can decline to answer.
    pin: (sessionId) => ['--session-id', sessionId],
    resume: (sessionId) => ['--resume', sessionId],
    resumeLatest: ['--continue'],
    selectors: [
      { flag: '--session-id', takesValue: true },
      { flag: '--resume', takesValue: true },
      { flag: '-r', takesValue: true },
      { flag: '--continue', takesValue: false },
      { flag: '-c', takesValue: false }
    ],
    prompt: (text) => [text]
  },
  codex: {
    executables: ['codex'],
    resume: (sessionId) => ['resume', sessionId],
    resumeLatest: ['resume', '--last'],
    selectors: [{ flag: 'resume', takesValue: true }],
    prompt: (text) => [text]
  },
  gemini: {
    executables: ['gemini'],
    resume: (sessionId) => ['--resume', sessionId],
    selectors: [{ flag: '--resume', takesValue: true }],
    // Not `-p`: that is the non-interactive form, and the pane is a conversation.
    prompt: (text) => ['--prompt-interactive', text]
  },
  opencode: {
    executables: ['opencode'],
    resume: (sessionId) => ['--session', sessionId],
    selectors: [{ flag: '--session', takesValue: true }],
    prompt: (text) => ['--prompt', text]
  },
  droid: {
    executables: ['droid'],
    resume: (sessionId) => ['--resume', sessionId],
    selectors: [{ flag: '--resume', takesValue: true }]
  }
}

export const AGENT_KINDS = Object.keys(AGENTS) as AgentKind[]

/** True when this agent lets us choose the session id before it starts. */
export function pinsOwnSessionId(agent: AgentKind): boolean {
  return AGENTS[agent].pin !== undefined
}

export function newSessionId(): string {
  // A UUID because the one CLI that accepts a chosen id insists on one, and
  // there is no reason for the others to disagree.
  return randomUUID()
}

/**
 * A session id we are willing to put on a command line.
 *
 * It reaches us from a stored file that a person can edit, so it is checked
 * rather than trusted: control characters would corrupt the line, a leading
 * dash would read as another flag, and an unbounded string is nobody's session
 * id. The command is built as an argv and quoted, so this is a second line of
 * defence rather than the only one.
 */
export function isUsableSessionId(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  if (value.startsWith('-')) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

export type Span = { start: number; end: number }
export type Tokenized = { ok: true; tokens: string[]; spans: Span[] } | { ok: false }

// Anything that makes a command line more than a list of words. A command
// containing one of these is left alone entirely: splicing a token out of a
// pipeline, a subshell or a redirect can change what it runs.
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '\n', '`'])

/**
 * Splits a command into words, keeping where each one sat in the original.
 *
 * The spans are the point. Rebuilding a command by re-quoting its tokens is a
 * lossy round trip — quoting style, spacing and anything the tokenizer got
 * slightly wrong all change — so edits are made by cutting and splicing the
 * original bytes, and every byte outside a removed token survives exactly.
 */
export function tokenizeCommand(command: string): Tokenized {
  const tokens: string[] = []
  const spans: Span[] = []
  let index = 0

  while (index < command.length) {
    const char = command[index] as string
    if (char === ' ' || char === '\t') {
      index += 1
      continue
    }
    if (SHELL_OPERATORS.has(char)) return { ok: false }
    if (char === '$' && command[index + 1] === '(') return { ok: false }

    const start = index
    let token = ''
    while (index < command.length) {
      const current = command[index] as string
      if (current === ' ' || current === '\t') break
      if (SHELL_OPERATORS.has(current)) return { ok: false }

      if (current === '\\') {
        const escaped = command[index + 1]
        if (escaped === undefined) return { ok: false }
        token += escaped
        index += 2
        continue
      }
      if (current === "'" || current === '"') {
        const close = command.indexOf(current, index + 1)
        if (close === -1) return { ok: false }
        const inner = command.slice(index + 1, close)
        // A double-quoted expansion is still an expansion; the value is not
        // knowable from the text, so the command is not modelable.
        if (current === '"' && (inner.includes('$') || inner.includes('`'))) return { ok: false }
        token += inner
        index = close + 1
        continue
      }
      if (current === '$') return { ok: false }
      token += current
      index += 1
    }

    tokens.push(token)
    spans.push({ start, end: index })
  }

  return { ok: true, tokens, spans }
}

/**
 * Where the executable sits, if it is one of `executables`.
 *
 * Only command position counts: the first word, a word after `--`, or one
 * after any number of `NAME=value` prefixes. Matching anywhere would let an
 * argument that merely ends in `/claude` — a key file, a project directory —
 * be mistaken for the program being run.
 */
export function executableIndex(tokens: readonly string[], executables: readonly string[]): number {
  let commandPosition = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (commandPosition) {
      const base = token.split(/[\\/]/).pop() ?? ''
      const name = base.replace(/\.(exe|cmd|bat|ps1)$/i, '')
      if (executables.includes(name)) return index
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      commandPosition = false
    }
    if (token === '--') commandPosition = true
  }
  return -1
}

/** Which agent this command launches, if any. */
export function detectAgent(command: string): AgentKind | null {
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return null
  for (const kind of AGENT_KINDS) {
    if (executableIndex(tokenized.tokens, AGENTS[kind].executables) !== -1) return kind
  }
  return null
}

/**
 * The command to run the first time, carrying the id we will resume with.
 *
 * Returns the command unchanged for an agent that mints its own id — there is
 * nothing to pin — and for a command that already names a session, because a
 * caller who has chosen their own session id means it.
 */
export function pinSessionCommand(command: string, agent: AgentKind, sessionId: string): string {
  const spec = AGENTS[agent]
  if (!spec.pin || !isUsableSessionId(sessionId)) return command
  if (carriesSelector(command, agent)) return command
  return spliceSelector(command, agent, spec.pin(sessionId))
}

/**
 * The command to run on the way back up.
 *
 * With an id, it resumes exactly that session. Without one — an agent that
 * never told us its id — it falls back to the agent's own "most recent session
 * here", which in a worktree means the session this pane was running, because
 * a worktree is one task's checkout and nothing else runs in it.
 *
 * Returns null when the agent offers neither, so the caller can start a plain
 * shell rather than pretend the conversation came back.
 */
export function resumeSessionCommand(command: string, agent: AgentKind, sessionId: string | null): string | null {
  const spec = AGENTS[agent]
  const argv =
    sessionId !== null && isUsableSessionId(sessionId) && spec.resume ? spec.resume(sessionId) : spec.resumeLatest
  if (!argv) return null
  return spliceSelector(command, agent, argv)
}

/**
 * The command to run when there is nothing to resume: the agent again, from the
 * top, under an id of its own.
 *
 * This is for the pane nobody ever spoke to. An agent writes a conversation
 * down when it has one, and a pane that was opened and then left alone has
 * none — so the id pinned for it last time names nothing, and asking to resume
 * it is asking for a conversation that was never had. Every selector is cut
 * out and, where the CLI allows it, a fresh id goes in: the pane comes back
 * where it was, ready, rather than coming back holding an error.
 *
 * A new id rather than the old one deliberately. The old one has been handed to
 * the agent once already, and a CLI within its rights to refuse an id it has
 * seen before would turn one silent failure into another.
 *
 * Null when the command cannot be modelled — a pipeline, an unclosed quote, an
 * agent reached through `ssh` or `env` in a way `executableIndex` will not
 * vouch for. This is the one place in this module where failing open is the
 * wrong move rather than the safe one. Everywhere else an unmodelable command
 * comes back with the selector appended, and the worst case is a CLI seeing two
 * of them and complaining. Here the caller *also* writes down the id it thinks
 * is on that line, so an append would leave the dead selector in place, put a
 * second one after it, and record an id that may well not be the one the agent
 * ends up using — a command and a record that disagree, quietly, from then on.
 * Saying no lets the caller fall back to a plain shell, which it can.
 */
export function restartSessionCommand(
  command: string,
  agent: AgentKind
): { command: string; agentSessionId?: string } | null {
  const spec = AGENTS[agent]
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return null
  if (executableIndex(tokenized.tokens, spec.executables) === -1) return null

  // Nothing to pin, and nothing to strip: a command for an agent that mints its
  // own ids only reaches this point when it names no session at all, because a
  // session on the line that this app did not put there is handled a step
  // earlier and never rewritten. So the command it was launched with is already
  // the command that starts it over.
  if (!spec.pin) return { command }

  const agentSessionId = newSessionId()
  return { command: spliceSelector(command, agent, spec.pin(agentSessionId)), agentSessionId }
}

/**
 * The launched line with the agent's first prompt on the end of it.
 *
 * Appended rather than spliced, and only ever to the line about to run — never
 * to the stored command. That command is what `resumeSessionCommand` rewrites,
 * and a resume is a conversation that has already been given this prompt;
 * putting it on the record would say it again on every launch. Quoted the way
 * every other argument this module adds is, so a prompt with several lines,
 * a quote, or a `$` reaches the agent as the one word it was typed as.
 */
export function firstPromptCommand(command: string, agent: AgentKind, prompt: string): string {
  const rule = AGENTS[agent].prompt
  if (rule === undefined) return command
  return `${command} ${rule(prompt).map(quoteArgument).join(' ')}`
}

/** Whether the command already names a session for this agent. */
export function carriesSelector(command: string, agent: AgentKind): boolean {
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return false
  const start = executableIndex(tokenized.tokens, AGENTS[agent].executables)
  if (start === -1) return false
  return tokenized.tokens.slice(start + 1).some((token) => matchSelector(AGENTS[agent].selectors, token) !== null)
}

function matchSelector(selectors: readonly Selector[], token: string): Selector | null {
  for (const selector of selectors) {
    if (token === selector.flag) return selector
    // The `--flag=value` form carries its value already, so nothing follows it.
    if (token.startsWith(`${selector.flag}=`)) return { ...selector, takesValue: false }
  }
  // Deliberately not matched: a joined short form such as `-rABC`. It is
  // indistinguishable from another option's dash-leading value, and guessing
  // wrong would cut a live argument out of the command.
  return null
}

/**
 * Replaces whatever session the command named with the one we want.
 *
 * Every uncertain case appends instead of splicing, which is the behaviour
 * that existed before any of this: worst case the agent sees two selectors and
 * complains, rather than being handed a command with a hole cut in it.
 */
function spliceSelector(command: string, agent: AgentKind, argv: readonly string[]): string {
  return spliceArguments(command, agent, argv, AGENTS[agent].selectors) ?? `${command} ${quoteArguments(argv)}`
}

/**
 * Puts arguments of this app's own on an agent's command line, in front of the
 * agent's `--` terminator where there is one and after everything else.
 *
 * The path the session selectors take, with nothing cut out along it. Null
 * rather than appended when the line cannot be modelled — a pipeline, an
 * unclosed quote, an agent this module cannot see in command position —
 * because an argument put after a terminator, or into a pipeline, would not
 * reach the agent, and a caller of this has somewhere honest to fall back to
 * that a caller of the selector splice does not: the line as it was.
 */
export function insertArguments(command: string, agent: AgentKind, argv: readonly string[]): string | null {
  return spliceArguments(command, agent, argv, [])
}

function quoteArguments(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(' ')
}

function spliceArguments(
  command: string,
  agent: AgentKind,
  argv: readonly string[],
  selectors: readonly Selector[]
): string | null {
  const spec = AGENTS[agent]
  const addition = quoteArguments(argv)

  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return null
  const { tokens, spans } = tokenized
  const start = executableIndex(tokens, spec.executables)
  if (start === -1) return null

  // Only whitespace may separate tokens. Anything else between two words is
  // syntax this module did not model, and splicing around it is not safe.
  for (let index = 0; index <= tokens.length; index += 1) {
    const gapStart = index === 0 ? 0 : (spans[index - 1] as Span).end
    const gapEnd = index === tokens.length ? command.length : (spans[index] as Span).start
    if (!/^[ \t]*$/.test(command.slice(gapStart, gapEnd))) return null
  }

  const cuts: Span[] = []
  // `--` after the agent's own name is the agent's argument terminator, so our
  // selector has to go in front of it rather than after.
  let terminator: number | null = null

  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '--') {
      terminator = (spans[index] as Span).start
      break
    }
    const selector = matchSelector(selectors, token)
    if (!selector) continue

    let cutStart = (spans[index] as Span).start
    // Take the space in front of the flag too, but never reach into the token
    // before it, whose span can end on an escaped space.
    const previousEnd = index === 0 ? 0 : (spans[index - 1] as Span).end
    while (cutStart > previousEnd && ' \t'.includes(command[cutStart - 1] as string)) cutStart -= 1

    let cutEnd = (spans[index] as Span).end
    const next = tokens[index + 1]
    if (selector.takesValue && next !== undefined && !next.startsWith('-')) {
      cutEnd = (spans[index + 1] as Span).end
      index += 1
    }
    cuts.push({ start: cutStart, end: cutEnd })
  }

  let result = command
  if (terminator !== null) result = `${result.slice(0, terminator)}${addition} ${result.slice(terminator)}`
  // Back to front, so an earlier cut's offsets are still valid.
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    const cut = cuts[index] as Span
    result = `${result.slice(0, cut.start)}${result.slice(cut.end)}`
  }
  return terminator !== null ? result : `${result} ${addition}`
}

/** POSIX single-quoting, which is the only form with no escapes inside it. */
export function quoteArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
