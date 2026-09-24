// The only place in the app that starts a git process. `shell: false` is not
// negotiable: names and refs are user input. Everything else exists so a hung
// or chatty git can never wedge the runtime.

import { spawn } from 'node:child_process'
import { GitCommandError } from './errors'

export type GitRun = {
  args: readonly string[]
  cwd: string
  /** Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Aborting kills the process; the rejection is a cancelled GitCommandError. */
  signal?: AbortSignal
  /** Extra environment on top of the sanitized base. */
  env?: NodeJS.ProcessEnv
  /** Skip the index lock. Safe for reads, required for anything polled. */
  readOnly?: boolean
  /**
   * Stop reading stdout at this many bytes and report the output as clipped,
   * rather than hitting the hard cap: a truncated right answer, not "no patch".
   */
  stdoutLimitBytes?: number
  /**
   * Each chunk of stderr as it arrives, for a push that spends a minute saying
   * what it is doing. Git only draws its meter when asked with `--progress`.
   */
  onStderr?: (chunk: string) => void
  /** Written to stdin, which is then closed. Only `git apply` needs it; a patch is assembled in memory. */
  stdin?: string
}

export type GitOutput = {
  exitCode: number
  stdout: string
  stderr: string
  /** True when `stdoutLimitBytes` cut the read short; `stdout` holds the prefix. */
  stdoutClipped?: boolean
}

export const DEFAULT_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 2_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export type GitRunner = {
  /** Rejects with GitCommandError unless git exits 0. */
  run(run: GitRun): Promise<GitOutput>
  /** Resolves with the exit code even when non-zero; still rejects on timeout/abort. */
  tryRun(run: GitRun): Promise<GitOutput>
  readonly binary: string
}

export function createGitRunner(binary = process.env.TEAMREE_GIT_BINARY || 'git'): GitRunner {
  const tryRun = (run: GitRun): Promise<GitOutput> => spawnGit(binary, run)
  return {
    binary,
    tryRun,
    async run(run) {
      const output = await tryRun(run)
      // A clipped read killed git itself, so the exit code describes our own signal.
      if (output.exitCode !== 0 && output.stdoutClipped !== true) {
        throw new GitCommandError({
          args: run.args,
          cwd: run.cwd,
          exitCode: output.exitCode,
          stderr: output.stderr
        })
      }
      return output
    }
  }
}

/**
 * Windows hands a .cmd or .bat to cmd.exe, which re-parses the command line, so
 * `&` or `|` in a ref would become a second command; this says why first.
 */
export function rejectBatchBinary(binary: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return null
  return `"${binary}" is a batch file; point TEAMREE_GIT_BINARY at git.exe itself, not at a .cmd or .bat wrapper`
}

function spawnGit(binary: string, run: GitRun): Promise<GitOutput> {
  const { args, cwd, signal } = run
  const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<GitOutput>((resolve, reject) => {
    const unusable = rejectBatchBinary(binary)
    if (unusable) {
      reject(new GitCommandError({ args, cwd, exitCode: null, stderr: unusable }))
      return
    }
    if (signal?.aborted) {
      reject(new GitCommandError({ args, cwd, exitCode: null, stderr: '', cancelled: true }))
      return
    }

    const child = spawn(binary, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: buildEnv(run)
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let cancelled = false
    let overflowed = false
    let clipped = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    let killTimer: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (killTimer) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      cancelled = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (run.stdin !== undefined) {
      // EPIPE is the normal end of a git that refused the patch before reading
      // all of it; the exit code describes the failure.
      child.stdin.on('error', () => undefined)
      child.stdin.end(run.stdin)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const stdoutLimit = run.stdoutLimitBytes
    child.stdout.on('data', (chunk: string) => {
      if (clipped) return
      // Kept whole: a chunk boundary is not a place to cut a patch.
      if (stdoutLimit !== undefined && stdout.length + chunk.length >= stdoutLimit) {
        stdout += chunk
        clipped = true
        stop()
        return
      }
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflowed = true
        stop()
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk
      // Handed on even past the cap: a watcher that stops being told anything
      // looks exactly like the hang it was added to rule out.
      try {
        run.onStderr?.(chunk)
      } catch {
        // A watcher that throws must never be the reason a git command fails.
      }
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT'
          ? `git executable not found (tried "${binary}"); install git or set TEAMREE_GIT_BINARY`
          : error.message
      finish(() => reject(new GitCommandError({ args, cwd, exitCode: null, stderr: hint })))
    })

    child.on('exit', () => {
      // A helper git started (`git-remote-http`, ssh) can outlive a killed git holding
      // stderr, and 'close' waits for every pipe: a hung server would hold the cancel too.
      if (!timedOut && !cancelled) return
      child.stdout.destroy()
      child.stderr.destroy()
    })

    child.on('close', (code) => {
      finish(() => {
        if (timedOut || cancelled) {
          reject(new GitCommandError({ args, cwd, exitCode: code, stderr, timedOut, cancelled }))
          return
        }
        if (clipped) {
          resolve({ exitCode: code ?? 0, stdout, stderr, stdoutClipped: true })
          return
        }
        if (overflowed) {
          reject(
            new GitCommandError({
              args,
              cwd,
              exitCode: code,
              stderr: `git produced more than ${MAX_OUTPUT_BYTES} bytes of output`
            })
          )
          return
        }
        resolve({ exitCode: code ?? -1, stdout, stderr })
      })
    })
  })
}

function buildEnv(run: GitRun): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A background worktree create must never stall on a credential prompt.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: process.env.GIT_ASKPASS ?? '',
    // Decisions here are made by reading git's prose, and git ships translations.
    // LANGUAGE outranks LC_ALL everywhere but the C locale, so it is cleared.
    LC_ALL: 'C',
    LANGUAGE: '',
    // Status is polled; the index lock on every poll would fight the user's own git.
    ...(run.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
    ...run.env,
    // Node started with this reads the keychain, and a hook or credential helper can be node. Undefined is left out.
    NODE_USE_SYSTEM_CA: undefined
  }
}
