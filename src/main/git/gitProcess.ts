// The only place in the app that starts a git process.
//
// `shell: false` is not negotiable: worktree names, branch names and refs are
// user input, and a shell would turn any of them into a command injection.
// Everything else here exists so a hung or chatty git can never wedge the
// runtime: separate pipes, a hard timeout, an abort hook, and an output cap.

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
   * rather than letting it run up against the hard cap and fail outright.
   *
   * For a caller that is going to cut the output down to a budget anyway, the
   * whole thing never needed to fit in memory first — and a 40MB patch that
   * ends as a rejection is reported to the user as "no patch", which is a
   * confident wrong answer rather than a truncated right one.
   */
  stdoutLimitBytes?: number
  /**
   * Called with each chunk of stderr as it arrives, before the process ends.
   *
   * Every other caller here waits for `close` and reads the whole of stderr at
   * once, which is right for a command that answers a question and wrong for
   * one that takes a minute: a push spends its time counting and compressing
   * objects and says so on stderr the entire time, and a caller that can only
   * see that afterwards has nothing to show anybody meanwhile. That was the
   * whole of "it gets stuck at git push" — the bytes existed and there was no
   * seam to hand them out of.
   *
   * stderr and not stdout because that is where git's progress meter goes;
   * stdout carries the machine-readable result, which is read once at the end
   * and means nothing in pieces. Note that git only draws that meter when it
   * believes something is watching, so a caller that wants it has to ask with
   * `--progress`.
   */
  onStderr?: (chunk: string) => void
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
      // A clipped read killed git itself, so the exit code describes our own
      // signal rather than anything git decided about the command.
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
 * Windows cannot execute a .cmd or .bat directly: CreateProcess hands it to
 * cmd.exe, which re-parses the whole command line by its own rules. Branch names
 * and refs are user input, so `&` or `|` in one would become a second command —
 * the exact injection `shell: false` exists to rule out. Node refuses to spawn a
 * batch file without a shell for the same reason; this says why first.
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

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const stdoutLimit = run.stdoutLimitBytes
    child.stdout.on('data', (chunk: string) => {
      if (clipped) return
      // Kept whole: the caller asked for a prefix long enough to answer its own
      // question, and a chunk boundary is not a place to cut a patch.
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
      // Handed on even past the cap: what is being dropped is the buffer this
      // process keeps, and a watcher that stops being told anything looks
      // exactly like the hang it was added to rule out.
      try {
        run.onStderr?.(chunk)
      } catch {
        // A watcher that throws is the watcher's problem. It must never be the
        // reason a git command this app is running fails.
      }
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT'
          ? `git executable not found (tried "${binary}"); install git or set TEAMREE_GIT_BINARY`
          : error.message
      finish(() => reject(new GitCommandError({ args, cwd, exitCode: null, stderr: hint })))
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
    // Several decisions in this app are made by reading git's own prose, and
    // git ships translations in most distro packages and in Git for Windows.
    // Under the C locale gettext hands back the untranslated message, which is
    // the only thing that makes reading it meaningful at all. LANGUAGE outranks
    // LC_ALL everywhere but the C locale, so it is cleared rather than trusted
    // to stay out of the way.
    LC_ALL: 'C',
    LANGUAGE: '',
    // Status is polled; taking the index lock on every poll would fight the
    // user's own git commands in the same checkout.
    ...(run.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
    ...run.env
  }
}
