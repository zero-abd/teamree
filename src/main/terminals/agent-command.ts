// Rewriting an agent's launch command so a session can be picked up again: one
// command pins the id, the other resumes it. The module fails open — anything
// it cannot model comes back unchanged or with the selector appended.

import { randomUUID } from 'node:crypto'
import type { AgentKind } from '../../shared/entities'

export type { AgentKind }

/** One flag and whether a separate token follows it carrying its value. */
type Selector = { flag: string; takesValue: boolean }

type AgentSpec = {
  /** Executable names, as they appear in command position. */
  executables: readonly string[]
  /** Argv that pins a chosen session id at launch; absent, the agent mints its own. */
  pin?: (sessionId: string) => readonly string[]
  /** Argv that resumes a session by the id we pinned. */
  resume?: (sessionId: string) => readonly string[]
  /** Argv that resumes the most recent session in this directory; a worktree is one task's checkout. */
  resumeLatest?: readonly string[]
  /** What to strip from a stored command before appending our own selector. */
  selectors: readonly Selector[]
  /** Argv that hands the agent its first prompt. Goes on last: a positional prompt swallows what follows. */
  prompt?: (text: string) => readonly string[]
}

const AGENTS: Readonly<Record<AgentKind, AgentSpec>> = {
  claude: {
    executables: ['claude'],
    // The one CLI here that lets the caller choose the id up front.
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
  // A UUID because the one CLI that accepts a chosen id insists on one.
  return randomUUID()
}

/**
 * A session id we are willing to put on a command line. It comes from an
 * editable file: control characters corrupt the line, a leading dash reads as a flag.
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

// A command containing one of these is left alone: splicing a token out of a
// pipeline, a subshell or a redirect can change what it runs.
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '\n', '`'])

/**
 * Splits a command into words, keeping where each sat: edits cut and splice
 * the original bytes, since re-quoting tokens is a lossy round trip.
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
        // A double-quoted expansion is still an expansion.
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
 * Where the executable sits, if it is one of `executables`. Command position
 * only, or an argument ending in `/claude` would be taken for the program.
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

/** The command to run the first time, carrying the id we will resume with; unchanged if a session is already named. */
export function pinSessionCommand(command: string, agent: AgentKind, sessionId: string): string {
  const spec = AGENTS[agent]
  if (!spec.pin || !isUsableSessionId(sessionId)) return command
  if (carriesSelector(command, agent)) return command
  return spliceSelector(command, agent, spec.pin(sessionId))
}

/**
 * The command to run on the way back up: that session by id, else the agent's
 * "most recent session here". Null when the agent offers neither.
 */
export function resumeSessionCommand(command: string, agent: AgentKind, sessionId: string | null): string | null {
  const spec = AGENTS[agent]
  const argv =
    sessionId !== null && isUsableSessionId(sessionId) && spec.resume ? spec.resume(sessionId) : spec.resumeLatest
  if (!argv) return null
  return spliceSelector(command, agent, argv)
}

/**
 * The command for a pane with nothing to resume: every selector cut out and a
 * fresh id pinned — not the old one, which a CLI may refuse having seen it.
 * Null, not appended, when the line cannot be modelled: the caller also records
 * the id it believes is on the line, and an append would make the two disagree.
 */
export function restartSessionCommand(
  command: string,
  agent: AgentKind
): { command: string; agentSessionId?: string } | null {
  const spec = AGENTS[agent]
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return null
  if (executableIndex(tokenized.tokens, spec.executables) === -1) return null

  // Nothing to pin or strip: a hand-named session was handled a step earlier.
  if (!spec.pin) return { command }

  const agentSessionId = newSessionId()
  return { command: spliceSelector(command, agent, spec.pin(agentSessionId)), agentSessionId }
}

/**
 * The launched line with the agent's first prompt on the end. Never on the
 * stored command: a resume has already been given it.
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
  // A joined short form such as `-rABC` is not matched: indistinguishable from
  // another option's dash-leading value.
  return null
}

/** Replaces whatever session the command named; uncertain cases append, so the worst case is two selectors. */
function spliceSelector(command: string, agent: AgentKind, argv: readonly string[]): string {
  return spliceArguments(command, agent, argv, AGENTS[agent].selectors) ?? `${command} ${quoteArguments(argv)}`
}

/**
 * Puts this app's own arguments on an agent's line, before its `--` terminator.
 * Null when the line cannot be modelled: an argument after a terminator or in a pipeline would not reach the agent.
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

  // Only whitespace may separate tokens; anything else is unmodelled syntax.
  for (let index = 0; index <= tokens.length; index += 1) {
    const gapStart = index === 0 ? 0 : (spans[index - 1] as Span).end
    const gapEnd = index === tokens.length ? command.length : (spans[index] as Span).start
    if (!/^[ \t]*$/.test(command.slice(gapStart, gapEnd))) return null
  }

  const cuts: Span[] = []
  // Our selector goes in front of the agent's `--` terminator.
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
    // Take the space in front too, but the previous span can end on an escaped space.
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
