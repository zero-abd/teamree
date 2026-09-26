// Content search: ripgrep when it is on PATH, else `git grep`. Output is read as
// it comes, batched to the caller, and the processes are killed at the hit cap,
// the deadline or a cancel. Both engines honour .gitignore and skip binaries.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  MAX_SEARCH_HITS,
  searchLine,
  searchPattern,
  type SearchFileHits,
  type SearchOptions,
  type SearchSummary
} from '../../shared/search'

export type SearchTarget = { worktreeId: string; path: string }

export type SearchRequest = SearchOptions & {
  targets: readonly SearchTarget[]
  query: string
  include?: readonly string[]
  limit?: number
  /** Ripgrep's path, or null for git grep. */
  rg: string | null
  git: string
  onHits: (files: SearchFileHits[]) => void
  timeoutMs?: number
  /** How often hits are handed on while a search runs. */
  flushMs?: number
  /** Worktrees searched at once. */
  concurrency?: number
}

export type SearchRun = {
  /** Kills whatever is running; `done` still settles, with what was found so far. */
  cancel: () => void
  done: Promise<SearchSummary & { cancelled: boolean }>
}

export const SEARCH_TIMEOUT_MS = 3000
const KILL_GRACE_MS = 1000

/** The engine's argv for one worktree, run from its root. */
export function searchArgs(
  engine: 'rg' | 'git',
  request: SearchOptions & { query: string; include?: readonly string[] }
): string[] {
  const include = request.include ?? []
  if (engine === 'rg') {
    return [
      '--no-config',
      '--null',
      '--line-number',
      '--no-heading',
      '--color=never',
      // Dotfiles are searched as git grep searches them; .gitignore still applies.
      '--hidden',
      '--glob=!.git',
      request.caseSensitive === true ? '--case-sensitive' : '--ignore-case',
      ...(request.wholeWord === true ? ['--word-regexp'] : []),
      ...(request.regex === true ? [] : ['--fixed-strings']),
      ...include.map((glob) => `--glob=${glob}`),
      '--regexp',
      request.query,
      '--',
      '.'
    ]
  }
  return [
    // A user's `grep.column` or `grep.fullName` would change the line format read below.
    '-c',
    'grep.column=false',
    '-c',
    'grep.fullName=false',
    'grep',
    '-n',
    '-I',
    '-z',
    '--no-color',
    '--untracked',
    ...(request.caseSensitive === true ? [] : ['-i']),
    ...(request.wholeWord === true ? ['-w'] : []),
    request.regex === true ? '-E' : '-F',
    '-e',
    request.query,
    '--',
    ...include.map((glob) => (glob.startsWith('!') ? `:(exclude)${glob.slice(1)}` : glob))
  ]
}

/** One output line as path, line number and text; null for anything else. */
export function parseSearchLine(
  engine: 'rg' | 'git',
  raw: string
): { path: string; line: number; text: string } | null {
  const pathEnd = raw.indexOf('\0')
  if (pathEnd <= 0) return null
  let path = raw.slice(0, pathEnd)
  const rest = raw.slice(pathEnd + 1)
  // rg prints `path\0line:text`, git grep `path\0line\0text`.
  const numberEnd = rest.indexOf(engine === 'rg' ? ':' : '\0')
  if (numberEnd <= 0) return null
  const line = Number(rest.slice(0, numberEnd))
  if (!Number.isInteger(line) || line < 1) return null
  if (engine === 'rg' && path.startsWith('./')) path = path.slice(2)
  return { path, line, text: rest.slice(numberEnd + 1) }
}

export function startSearch(request: SearchRequest): SearchRun {
  const engine = request.rg === null ? 'git' : 'rg'
  const binary = request.rg ?? request.git
  const limit = Math.min(request.limit ?? MAX_SEARCH_HITS, MAX_SEARCH_HITS)
  const pattern = searchPattern(request.query, request)
  const args = searchArgs(engine, request)
  const started = Date.now()

  const queue = [...request.targets]
  const running = new Set<ChildProcess>()
  let pending = new Map<string, SearchFileHits>()
  let matches = 0
  let truncated = false
  let timedOut = false
  let cancelled = false
  let stopped = false
  let settled = false
  let error: string | undefined

  let settle: (summary: SearchSummary & { cancelled: boolean }) => void = () => {}
  const done = new Promise<SearchSummary & { cancelled: boolean }>((resolve) => {
    settle = resolve
  })

  const flush = (): void => {
    if (pending.size === 0 || cancelled) return
    const files = [...pending.values()]
    pending = new Map()
    request.onHits(files)
  }
  const ticker = setInterval(flush, request.flushMs ?? 50)
  const deadline = setTimeout(() => {
    timedOut = true
    stop()
  }, request.timeoutMs ?? SEARCH_TIMEOUT_MS)

  const finish = (): void => {
    if (settled || running.size > 0 || (queue.length > 0 && !stopped)) return
    settled = true
    clearInterval(ticker)
    clearTimeout(deadline)
    flush()
    settle({
      matches,
      truncated,
      timedOut,
      cancelled,
      elapsedMs: Date.now() - started,
      engine,
      ...(error === undefined ? {} : { error })
    })
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    queue.length = 0
    for (const child of running) kill(child)
    finish()
  }

  const add = (target: SearchTarget, raw: string): void => {
    if (stopped) return
    const parsed = parseSearchLine(engine, raw)
    if (parsed === null) return
    const key = `${target.worktreeId}\0${parsed.path}`
    let file = pending.get(key)
    if (!file) {
      file = { worktreeId: target.worktreeId, path: parsed.path, lines: [] }
      pending.set(key, file)
    }
    file.lines.push(searchLine(parsed.line, parsed.text, pattern))
    matches += 1
    if (matches >= limit) {
      truncated = true
      stop()
    }
  }

  const next = (): void => {
    const target = stopped ? undefined : queue.shift()
    if (!target) {
      finish()
      return
    }
    const child = spawn(binary, args, {
      cwd: target.path,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: searchEnv(engine)
    })
    running.add(child)
    let buffered = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1 && !stopped) {
        add(target, buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk
    })
    const closed = (code: number | null): void => {
      if (!running.delete(child)) return
      if (buffered !== '' && !stopped) add(target, buffered)
      // Exit 1 is "no match" for both; anything above it is the engine refusing, e.g. a bad regex.
      if (!stopped && code !== null && code > 1) error ??= reason(stderr) ?? `${engine} exited ${code}`
      next()
    }
    child.on('error', (failure) => {
      error ??= failure.message
      // A binary that never started emits no close.
      if (child.pid === undefined) closed(null)
    })
    child.on('close', closed)
  }

  const lanes = Math.max(1, Math.min(request.concurrency ?? 3, queue.length))
  if (queue.length === 0) finish()
  for (let lane = 0; lane < lanes; lane += 1) next()

  return {
    cancel: () => {
      if (stopped) return
      cancelled = true
      stop()
    },
    done
  }
}

function kill(child: ChildProcess): void {
  child.kill('SIGTERM')
  const hard = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
  hard.unref?.()
  child.once('close', () => clearTimeout(hard))
}

function searchEnv(engine: 'rg' | 'git'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_SYSTEM_CA: undefined }
  if (engine === 'rg') return { ...env, RIPGREP_CONFIG_PATH: undefined }
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

// rg puts the reason last (`error: unclosed group`), git grep first (`fatal: …`).
function reason(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  const line = lines.find((entry) => entry.startsWith('error:')) ?? lines[0]
  return line?.replace(/^(rg: )?(fatal|error): /, '')
}
