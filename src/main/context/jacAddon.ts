// Settings › Add-ons › Jac Graph Memory: installed with the person's own uv into <userData>/addons/jac,
// off until turned on, and then run as a context provider. The add-on is a process or nothing here.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONTEXT_PROVIDER_ENV, type AddonStatus } from '../../shared/contextProvider'
import { findProgram } from '../git/worktreeLanding'
import { ProviderProcess, type ProviderEventLine, type ProviderProcessOptions } from './providerProcess'
import type { ContextProvider } from './source'

/** The add-on release this build installs. */
export const JAC_ADDON_VERSION = '0.1.0'

/** Installs this pip requirement instead, e.g. a local checkout of addons/jac-memory. */
export const JAC_ADDON_SPEC_ENV = 'TEAMREE_JAC_ADDON_SPEC'

/** PyPI first; the tagged source in the repository when the index has no such release. */
export const JAC_ADDON_SPECS: readonly string[] = [
  `teamree-jac==${JAC_ADDON_VERSION}`,
  `teamree-jac @ git+https://github.com/zero-abd/teamree@jac-addon-v${JAC_ADDON_VERSION}#subdirectory=addons/jac-memory`
]

const INSTALL_STEP_TIMEOUT_MS = 10 * 60_000
const MARKER = 'installed.json'

export type RunResult = { code: number | null; stdout: string; stderr: string }
export type Run = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<RunResult>

export type JacAddonOptions = {
  userDataDir: string
  /** Settings › Jac Graph Memory; off by default. */
  enabled: () => boolean
  setEnabled: (on: boolean) => void
  onChange: () => void
  greet: () => Promise<readonly ProviderEventLine[]>
  app: string
  env?: NodeJS.ProcessEnv
  findUv?: () => string | null
  run?: Run
  provider?: (options: ProviderProcessOptions) => ProviderProcess
}

type Installed = { version: string; command: string; args: string[]; cwd?: string }

export class JacAddon {
  readonly #options: JacAddonOptions
  readonly #env: NodeJS.ProcessEnv
  #installing = false
  #installProblem: string | undefined
  #provider: ProviderProcess | undefined
  #uv: string | null | undefined

  constructor(options: JacAddonOptions) {
    this.#options = options
    this.#env = childEnv(options.env ?? process.env)
  }

  get dir(): string {
    return join(this.#options.userDataDir, 'addons', 'jac')
  }

  status(): AddonStatus {
    const base: AddonStatus = { id: 'jac-memory', state: 'off' }
    if (this.#installing) return { ...base, state: 'installing' }
    const installed = this.#installed()
    if (installed === undefined) {
      if (this.#installProblem !== undefined) return { ...base, state: 'failed', detail: this.#installProblem }
      return this.#findUv() === null ? { ...base, needs: 'uv' } : base
    }
    const version = { version: this.#provider?.version ?? installed.version }
    const provider = this.#provider
    if (provider?.state === 'failed') {
      return { ...base, ...version, state: 'failed', ...(provider.detail ? { detail: provider.detail } : {}) }
    }
    if (provider?.state === 'running') return { ...base, ...version, state: 'running' }
    if (provider?.state === 'starting') return { ...base, ...version, state: 'running', detail: 'starting' }
    return { ...base, ...version }
  }

  /** Answers only while running; a provider still starting or off adds nothing. */
  providers(): readonly ContextProvider[] {
    return this.#provider?.state === 'running' ? [this.#provider] : []
  }

  /** Starts or stops the process to match the setting. Nothing is spawned while it is off. */
  sync(): void {
    const installed = this.#installed()
    if (!this.#options.enabled() || installed === undefined) {
      if (this.#provider !== undefined) {
        const stopping = this.#provider
        this.#provider = undefined
        void stopping.stop().finally(() => this.#options.onChange())
      }
      return
    }
    if (this.#provider !== undefined) return
    const make = this.#options.provider ?? ((options) => new ProviderProcess(options))
    this.#provider = make({
      name: 'jac-memory',
      command: installed.command,
      args: installed.args,
      ...(installed.cwd === undefined ? {} : { cwd: installed.cwd }),
      env: this.#env,
      app: this.#options.app,
      greet: this.#options.greet,
      onState: () => this.#options.onChange()
    })
    this.#provider.start()
    this.#options.onChange()
  }

  /** Turned off and on again by the person: a failed add-on gets a fresh start. */
  restart(): void {
    const provider = this.#provider
    if (provider === undefined) return this.sync()
    if (provider.state === 'failed') provider.start()
  }

  async install(): Promise<AddonStatus> {
    if (this.#installing) return this.status()
    const uv = this.#findUv(true)
    if (uv === null) return this.status()
    this.#installing = true
    this.#installProblem = undefined
    this.#options.onChange()
    try {
      const venv = join(this.dir, 'venv')
      await mkdir(this.dir, { recursive: true })
      await this.#step(uv, ['venv', '--no-project', '--clear', '--python', '3.12', venv])
      const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const specs = nonEmpty(this.#env[JAC_ADDON_SPEC_ENV]) ?? JAC_ADDON_SPECS
      let problem: Error | undefined
      for (const spec of typeof specs === 'string' ? [specs] : specs) {
        try {
          await this.#step(uv, ['pip', 'install', '--no-progress', '--python', python, spec])
          problem = undefined
          break
        } catch (error) {
          problem = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (problem !== undefined) throw problem
      const said = await this.#step(binPath(venv), ['--version'])
      const version = said.stdout.trim().split(/\s+/).pop() ?? JAC_ADDON_VERSION
      await writeFile(join(this.dir, MARKER), `${JSON.stringify({ version, at: Date.now() })}\n`)
      this.#installing = false
      this.#options.setEnabled(true)
      this.sync()
    } catch (error) {
      this.#installProblem = error instanceof Error ? error.message : String(error)
    } finally {
      this.#installing = false
      this.#options.onChange()
    }
    return this.status()
  }

  async close(): Promise<void> {
    const provider = this.#provider
    this.#provider = undefined
    await provider?.stop()
  }

  async #step(file: string, args: readonly string[]): Promise<RunResult> {
    const run = this.#options.run ?? runFile
    const result = await run(file, args, { env: this.#env, timeoutMs: INSTALL_STEP_TIMEOUT_MS })
    if (result.code === 0) return result
    const said = `${result.stderr}\n${result.stdout}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    throw new Error(said.find((line) => /error|failed|not found/i.test(line)) ?? said.pop() ?? `exit ${result.code}`)
  }

  #installed(): Installed | undefined {
    const override = nonEmpty(this.#env[CONTEXT_PROVIDER_ENV])
    if (override !== undefined) {
      const [command, ...args] = override.trim().split(/\s+/)
      return command === undefined ? undefined : { version: 'dev', command, args }
    }
    const venv = join(this.dir, 'venv')
    const bin = binPath(venv)
    if (!existsSync(bin)) return undefined
    try {
      const marker = JSON.parse(readFileSync(join(this.dir, MARKER), 'utf8')) as { version?: unknown }
      const version = typeof marker.version === 'string' ? marker.version : JAC_ADDON_VERSION
      return { version, command: bin, args: ['serve', '--data', join(this.dir, 'data')], cwd: this.dir }
    } catch {
      return undefined
    }
  }

  /** Looked up once, and again before an install. A Dock launch has no profile PATH, so uv's own folders too. */
  #findUv(again = false): string | null {
    if (this.#uv !== undefined && !again) return this.#uv
    const find =
      this.#options.findUv ??
      (() => {
        const home = homedir()
        const known = [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
        return findProgram('uv', [this.#env.PATH, known.join(':')])
      })
    this.#uv = find()
    return this.#uv
  }
}

function binPath(venv: string): string {
  return join(venv, process.platform === 'win32' ? 'Scripts/teamree-jac.exe' : 'bin/teamree-jac')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/** The app's environment without what would change how a child Node or the keychain behaves. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  delete next.NODE_OPTIONS
  delete next.NODE_USE_SYSTEM_CA
  return next
}

function runFile(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<RunResult>((resolve) => {
    execFile(
      file,
      [...args],
      { env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error?.message ?? '')) })
      }
    )
  })
}
