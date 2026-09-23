// The one thing this CLI does that is not a question to the runtime: a clone
// for `team accept`, run through `createGitRunner` (shell: false, timeout,
// output cap, sanitised environment) rather than a second copy of all four.

import { runClone, type CloneFailure as GitCloneFailure } from '../main/git/clone.js'
import { createGitRunner } from '../main/git/gitProcess.js'
import { checkTransport, type TransportCheck } from '../shared/origin.js'

/** As long as a push may take: a default two minutes reports a healthy large clone as a failure. */
const CLONE_TIMEOUT_MS = 10 * 60_000

/** git's own words, capped so a wall of them cannot become the whole answer. */
const MAX_GIT_WORDS = 4000

export type CloneableCheck = TransportCheck

/**
 * Whether this is an address teamree will run git against. The allowlist is
 * `checkTransport` in `src/shared/origin.ts`; a second list here once disagreed
 * with the runtime's in both directions. Asked again inside `cloneRepository`,
 * the function that starts the process, where the guarantee has to hold.
 */
export function checkCloneable(origin: string): CloneableCheck {
  return checkTransport(origin)
}

export type CloneFailure = 'auth' | 'host-key' | 'timeout' | 'other'

export type CloneOutcome =
  | { ok: true; path: string }
  /** `error` is git's own words, whole; `advice` is the one thing to do next. */
  | { ok: false; kind: CloneFailure; error: string; advice: string }

export type CloneOptions = {
  /** The repository to copy: a URL, or the path a shared volume is mounted at. */
  origin: string
  /** Absolute path to create. git makes the intermediate directories itself. */
  into: string
  /** An existing directory to run git from; only the config it reads depends on it. */
  cwd: string
  /** Called with each line git prints while it works. Text mode only — see `accept`. */
  onProgress?: (line: string) => void
}

/** Copies the repository, or says why it could not in words git wrote; see `runClone`. */
export async function cloneRepository(options: CloneOptions): Promise<CloneOutcome> {
  // This is the function that starts the process, so the guarantee holds here.
  const cloneable = checkCloneable(options.origin)
  if (!cloneable.ok) {
    return {
      ok: false,
      kind: 'other',
      error: cloneable.reason,
      advice: 'Ask whoever sent the invitation for the address they clone this repository with themselves.'
    }
  }

  const result = await runClone(createGitRunner(), {
    origin: options.origin,
    into: options.into,
    cwd: options.cwd,
    timeoutMs: CLONE_TIMEOUT_MS,
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  if (result.ok) return { ok: true, path: options.into }
  if (result.kind === 'timeout') {
    return {
      ok: false,
      kind: 'timeout',
      error: clip(result.stderr) || `git clone produced nothing for ${Math.round(CLONE_TIMEOUT_MS / 60_000)} minutes`,
      advice:
        `git never finished copying ${options.origin}. That is usually a credential this command cannot be ` +
        'asked for, or a host that is not answering; running the same clone once in a terminal says which.'
    }
  }
  return {
    ok: false,
    kind: result.kind === 'auth' || result.kind === 'host-key' ? result.kind : 'other',
    error: clip(result.stderr) || 'git clone failed',
    advice: cloneRefusal(result.kind, result.stderr, options.origin)
  }
}

/**
 * The one thing to do about a clone that did not happen. Over https "repository
 * not found" covers both a missing repository and one this account may not read.
 */
function cloneRefusal(kind: GitCloneFailure, stderr: string, origin: string): string {
  const text = stderr.trim()
  switch (kind) {
    case 'not-found':
      return (
        `git found no repository at ${origin}. Either the invitation names the wrong place, or this machine is not ` +
        'allowed to see it — check the address with whoever sent the invitation.'
      )
    case 'host-key':
      return (
        `ssh has never accepted the host key for ${origin} and will not guess at one. Run ssh against that host ` +
        'once in a terminal, accept the key, and run this again.'
      )
    case 'auth':
      return (
        `${origin} refused this machine: ${firstLine(text)}. Add the key to your agent with ` +
        '`ssh-add --apple-use-keychain`, or store the credential with `git config --global credential.helper ' +
        'osxkeychain`, and run this again.'
      )
    default:
      return firstLine(text) || `git could not copy ${origin}`
  }
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_GIT_WORDS ? trimmed : `${trimmed.slice(0, MAX_GIT_WORDS)}…`
}
