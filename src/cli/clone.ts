// The one thing this CLI does that is not a question to the runtime.
//
// `project.add` adopts a checkout that is already on the disk — it inspects it
// with git and refuses anything that is not a repository — and there is no
// runtime method that clones, deliberately: nothing in the app has ever needed
// to fetch a repository nobody had. `teamree team accept` does. A joiner who
// has never seen this repository has to get it before there is a project to add,
// and a command that stopped at that point to print `git clone …` would put the
// shell step back in the middle of the one flow this exists to take it out of.
//
// So this runs git, once, through `createGitRunner` — the only place in the app
// that starts a git process, with `shell: false`, a timeout, an output cap and a
// sanitised environment — rather than reaching for `child_process` here and
// arriving at a second, worse copy of all four.

import { GitCommandError } from '../main/git/errors.js'
import { createGitRunner } from '../main/git/gitProcess.js'
import { splitProgress } from '../main/teamwork/publish.js'
import { pushFailureKind } from '../main/git/worktreePush.js'

/**
 * As long as a push is allowed to take, and for the same reason: this is the
 * one command here that copies a repository across a network, and a default two
 * minutes would report a healthy clone of a large repository as a failure.
 */
const CLONE_TIMEOUT_MS = 10 * 60_000

/** git's own words, capped so a wall of them cannot become the whole answer. */
const MAX_GIT_WORDS = 4000

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

/**
 * Copies the repository, or says why it could not in words git wrote.
 *
 * ssh runs in batch mode, the same way a publish runs it and for the same
 * reason: `GIT_TERMINAL_PROMPT=0` stops *git* asking for anything and does
 * nothing at all to ssh, which opens `/dev/tty` directly for a key passphrase or
 * for a host key it has never seen. The caller here is usually an agent with no
 * tty worth prompting on, so without this a first clone from a host this Mac has
 * never met waits ten minutes on a question nobody will ever see. Batch mode
 * turns that wait into a refusal with a sentence in it.
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneOutcome> {
  const runner = createGitRunner()
  const configured = await runner.tryRun({
    args: ['config', '--get', 'core.sshCommand'],
    cwd: options.cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  const base =
    process.env['GIT_SSH_COMMAND']?.trim() || (configured.exitCode === 0 ? configured.stdout.trim() : '') || 'ssh'

  let result
  try {
    result = await runner.tryRun({
      // `--` first, so an origin that begins with a dash is a repository and
      // never an option. The origin arrives in a link somebody was sent.
      args: ['clone', '--progress', '--', options.origin, options.into],
      cwd: options.cwd,
      timeoutMs: CLONE_TIMEOUT_MS,
      env: { GIT_SSH_COMMAND: `${base} -o BatchMode=yes` },
      onStderr: (chunk) => {
        if (options.onProgress) for (const line of splitProgress(chunk)) options.onProgress(line)
      }
    })
  } catch (error) {
    // `tryRun` resolves for a git that ran and refused; it rejects only for one
    // that never finished or never started, and the first of those is the one
    // worth its own sentence.
    if (!(error instanceof GitCommandError)) throw error
    if (error.timedOut) {
      return {
        ok: false,
        kind: 'timeout',
        error: clip(error.stderr) || `git clone produced nothing for ${Math.round(CLONE_TIMEOUT_MS / 60_000)} minutes`,
        advice:
          `git never finished copying ${options.origin}. That is usually a credential this command cannot be ` +
          'asked for, or a host that is not answering; running the same clone once in a terminal says which.'
      }
    }
    throw error
  }

  if (result.exitCode === 0) return { ok: true, path: options.into }
  const error = clip(result.stderr) || clip(result.stdout) || `git exited ${result.exitCode}`
  return {
    ok: false,
    kind: cloneFailureKind(result.stderr),
    error,
    advice: cloneRefusal(result.stderr, options.origin)
  }
}

/**
 * Which kind of refusal this is.
 *
 * It reuses the push classifier rather than growing a second copy of the same
 * regular expressions. What those patterns actually read is the transport —
 * ssh's host-key sentence, git's "terminal prompts disabled", a host answering
 * 403 — and a clone and a push meet exactly the same transport. `rejected` is
 * the one verdict that belongs to a push alone and cannot be reached from here:
 * there is no ref to be behind when there is no repository yet.
 */
function cloneFailureKind(stderr: string): CloneFailure {
  const kind = pushFailureKind(stderr)
  return kind === 'auth' || kind === 'host-key' ? kind : 'other'
}

/**
 * The one thing to do about a clone that did not happen.
 *
 * "Repository not found" is the case worth separating by hand: over https it is
 * what a host says both for a repository that is not there and for one this
 * account may not read, and sending somebody to check their ssh agent about a
 * typo in a URL would be an instruction dressed as a diagnosis.
 */
function cloneRefusal(stderr: string, origin: string): string {
  const text = stderr.trim()
  if (/repository not found|does not appear to be a git repository|not a git repository/i.test(text)) {
    return (
      `git found no repository at ${origin}. Either the invitation names the wrong place, or this machine is not ` +
      'allowed to see it — check the address with whoever sent the invitation.'
    )
  }
  switch (cloneFailureKind(text)) {
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
