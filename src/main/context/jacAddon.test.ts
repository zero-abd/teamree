// Settings › Add-ons › Jac Graph Memory: off by default, installed with uv, run as a provider or not at all.

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_PROVIDER_ENV } from '../../shared/contextProvider'
import {
  installReason,
  JAC_ADDON_SPEC_ENV,
  JAC_ADDON_SPECS,
  JacAddon,
  type JacAddonOptions,
  type Run
} from './jacAddon'
import { ProviderProcess, type ProviderProcessOptions } from './providerProcess'

const STUB = fileURLToPath(new URL('./fixtures/stubProvider.mjs', import.meta.url))

let userDataDir: string
let enabled: boolean
let changes: number
let made: ProviderProcessOptions[]
const addons: JacAddon[] = []

function addon(options: Partial<JacAddonOptions> = {}): JacAddon {
  const created = new JacAddon({
    userDataDir,
    enabled: () => enabled,
    setEnabled: (on) => {
      enabled = on
    },
    onChange: () => {
      changes += 1
    },
    greet: async () => [],
    app: 'teamree test',
    env: { PATH: '/usr/bin:/bin' },
    findUv: () => '/fake/uv',
    provider: (options) => {
      made.push(options)
      return new ProviderProcess({ ...options, command: process.execPath, args: [STUB, 'good'] })
    },
    ...options
  })
  addons.push(created)
  return created
}

/** A uv that makes the venv and the add-on's command, and records what it was asked. */
function fakeUv(calls: string[][], fail?: (args: readonly string[]) => boolean): Run {
  return async (file, args) => {
    calls.push([path.basename(file), ...args])
    if (fail?.(args)) return { code: 2, stdout: '', stderr: '  × No solution found when resolving: teamree-jac\n' }
    if (args[0] === 'venv') await mkdir(path.join(args.at(-1) as string, 'bin'), { recursive: true })
    if (args[0] === 'pip') await writeFile(path.join(userDataDir, 'addons/jac/venv/bin/teamree-jac'), '')
    return { code: 0, stdout: args[0] === '--version' ? '0.1.0\n' : '', stderr: '' }
  }
}

/** What uv 0.12 prints when the tagged source cannot be fetched: miette wraps inside the requirement. */
const UV_OFFLINE_GIT = `Using Python 3.12.13 environment at: venv
   Updating https://github.com/zero-abd/teamree (jac-addon-v0.1.0)
  × Failed to download and build \`teamree-jac @
  │ git+https://github.com/zero-abd/teamree@jac-addon-v0.1.0#subdirectory=addons/jac-memory\`
  ├─▶ Git operation failed
  ├─▶ failed to clone into: uvcache/git-v0/db/9fea7243dd48d34f
  ├─▶ failed to fetch branch or tag \`jac-addon-v0.1.0\`
  ╰─▶ Remote Git fetches are not allowed because network connectivity is
      disabled (i.e., with \`--offline\`)
`

async function until(test: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'teamree-addon-'))
  enabled = false
  changes = 0
  made = []
})

afterEach(async () => {
  await Promise.all(addons.splice(0).map((one) => one.close()))
  await rm(userDataDir, { recursive: true, force: true })
})

describe('the Jac Graph Memory add-on', () => {
  it('is off and spawns nothing until installed and turned on', async () => {
    const jac = addon()
    jac.sync()
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off' })

    // Installed, but the setting is off, as it is by default.
    await mkdir(path.join(userDataDir, 'addons/jac/venv/bin'), { recursive: true })
    await writeFile(path.join(userDataDir, 'addons/jac/venv/bin/teamree-jac'), '')
    await writeFile(path.join(userDataDir, 'addons/jac/installed.json'), '{"version":"0.1.0"}')
    jac.sync()
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off', version: '0.1.0' })
    expect(made).toEqual([])
    expect(jac.providers()).toEqual([])
  })

  it('says it needs uv and never runs anything without it', async () => {
    const calls: string[][] = []
    const jac = addon({ findUv: () => null, run: fakeUv(calls) })
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off', needs: 'uv' })
    expect(await jac.install()).toEqual({ id: 'jac-memory', state: 'off', needs: 'uv' })
    expect(calls).toEqual([])
    expect(made).toEqual([])
  })

  it('installs a pinned release into its own venv, turns itself on and runs', async () => {
    const calls: string[][] = []
    const jac = addon({ run: fakeUv(calls) })
    const status = await jac.install()
    const venv = path.join(userDataDir, 'addons/jac/venv')
    expect(calls).toEqual([
      ['uv', 'venv', '--no-project', '--clear', '--python', '3.12', venv],
      [
        'uv',
        'pip',
        'install',
        '--no-progress',
        '--python',
        path.join(venv, 'bin/python'),
        JAC_ADDON_SPECS[0] as string
      ],
      ['teamree-jac', '--version']
    ])
    expect(JSON.parse(await readFile(path.join(userDataDir, 'addons/jac/installed.json'), 'utf8'))).toMatchObject({
      version: '0.1.0'
    })
    expect(enabled).toBe(true)
    expect(status.state).toBe('running')
    expect(made[0]).toMatchObject({
      command: path.join(venv, 'bin/teamree-jac'),
      args: ['serve', '--data', path.join(userDataDir, 'addons/jac/data')]
    })
    await until(() => jac.status().detail === undefined)
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'running', version: '9.9.9' })
    expect(jac.providers()).toHaveLength(1)
    expect(changes).toBeGreaterThan(0)
  })

  it('falls back to the tagged source when the index has no release, and says why it failed when neither works', async () => {
    const calls: string[][] = []
    const pypiMissing = addon({ run: fakeUv(calls, (args) => args.includes(JAC_ADDON_SPECS[0] as string)) })
    expect((await pypiMissing.install()).state).toBe('running')
    expect(calls[2]?.at(-1)).toBe(JAC_ADDON_SPECS[1])

    await rm(path.join(userDataDir, 'addons'), { recursive: true, force: true })
    enabled = false
    const broken = addon({ run: fakeUv([], (args) => args[0] === 'pip') })
    expect(await broken.install()).toMatchObject({
      id: 'jac-memory',
      state: 'failed',
      detail: 'No solution found when resolving: teamree-jac'
    })
    expect(enabled).toBe(false)
  })

  it('keeps what uv downloads in its own folder, for install and run, so removing the folder removes it all', async () => {
    const uv = path.join(userDataDir, 'stub/uv')
    await mkdir(path.dirname(uv), { recursive: true })
    await writeFile(
      uv,
      `#!/bin/sh
case "$1" in
  venv) for last; do :; done; mkdir -p "$last/bin" ;;
  pip) mkdir -p "$UV_CACHE_DIR" && echo wheel > "$UV_CACHE_DIR/teamree_jac.whl"
    printf '#!/bin/sh\\necho teamree-jac 0.1.0\\n' > "$(dirname "$5")/teamree-jac"; chmod +x "$(dirname "$5")/teamree-jac" ;;
esac
`
    )
    await chmod(uv, 0o755)
    const elsewhere = path.join(userDataDir, 'global-uv-cache')
    const jac = addon({ findUv: () => uv, env: { PATH: '/usr/bin:/bin', UV_CACHE_DIR: elsewhere } })
    expect(await jac.install()).toMatchObject({ state: 'running' })
    const cache = path.join(userDataDir, 'addons/jac/uv-cache')
    expect(existsSync(path.join(cache, 'teamree_jac.whl'))).toBe(true)
    expect(existsSync(elsewhere)).toBe(false)
    expect(made[0]?.env?.UV_CACHE_DIR).toBe(cache)
  })

  it('notices uv arriving or leaving without a restart', () => {
    let uv: string | null = null
    const jac = addon({ findUv: () => uv })
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off', needs: 'uv' })
    uv = '/fake/uv'
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off' })
    uv = null
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off', needs: 'uv' })
  })

  it('a failed install names the root cause, keeps and logs the whole output, removes the half-made venv, and can be retried', async () => {
    let offline = true
    const calls: string[][] = []
    const working = fakeUv(calls)
    const jac = addon({
      run: async (file, args, options) => {
        if (offline && args[0] === 'pip') {
          calls.push([path.basename(file), ...args])
          return { code: 1, stdout: '', stderr: UV_OFFLINE_GIT }
        }
        return working(file, args, options)
      }
    })
    const failed = await jac.install()
    expect(failed).toMatchObject({
      state: 'failed',
      detail: 'Remote Git fetches are not allowed because network connectivity is disabled (i.e., with `--offline`)'
    })
    expect(failed.output).toContain('#subdirectory=addons/jac-memory`')
    expect(failed.output).toContain(`uv pip install --no-progress`)
    const log = await readFile(path.join(userDataDir, 'addons/jac/install.log'), 'utf8')
    expect(log).toContain('Failed to download and build `teamree-jac @')
    expect(log).toContain(JAC_ADDON_SPECS[0] as string)
    expect(existsSync(path.join(userDataDir, 'addons/jac/venv'))).toBe(false)
    expect(jac.status()).toMatchObject({ state: 'failed', output: failed.output })

    offline = false
    expect((await jac.install()).state).toBe('running')
    expect(jac.status().output).toBeUndefined()
  })

  it('reads the wrapped uv error chain as one line', () => {
    const noRelease = `  × No solution found when resolving dependencies:
  ╰─▶ Because teamree-jac was not found in the cache and you require
      teamree-jac==0.1.0, we can conclude that your requirements are
      unsatisfiable.

hint: Packages were unavailable because the network was disabled.`
    expect(installReason(noRelease)).toBe(
      'Because teamree-jac was not found in the cache and you require teamree-jac==0.1.0, we can conclude that your requirements are unsatisfiable.'
    )
    expect(installReason('Using CPython 3.12\nerror: No interpreter found for Python 3.12\nexit soon\n')).toBe(
      'No interpreter found for Python 3.12'
    )
    expect(installReason('\n')).toBeUndefined()
  })

  it('installs what the environment names instead, for a local checkout', async () => {
    const calls: string[][] = []
    const jac = addon({ run: fakeUv(calls), env: { PATH: '/usr/bin', [JAC_ADDON_SPEC_ENV]: '/src/addons/jac-memory' } })
    await jac.install()
    expect(calls[1]?.at(-1)).toBe('/src/addons/jac-memory')
  })

  it('stops when turned off and starts fresh when turned on again', async () => {
    const jac = addon({ run: fakeUv([]) })
    await jac.install()
    await until(() => jac.providers().length === 1)
    enabled = false
    jac.sync()
    expect(jac.providers()).toEqual([])
    expect(jac.status()).toEqual({ id: 'jac-memory', state: 'off', version: '0.1.0' })
    enabled = true
    jac.sync()
    await until(() => jac.providers().length === 1)
    expect(made).toHaveLength(2)
  })

  it('runs a development provider the environment names, without installing', async () => {
    enabled = true
    const jac = new JacAddon({
      userDataDir,
      enabled: () => enabled,
      setEnabled: () => {},
      onChange: () => {},
      greet: async () => [],
      app: 't',
      env: { [CONTEXT_PROVIDER_ENV]: `${process.execPath} ${STUB} good` },
      findUv: () => null
    })
    addons.push(jac)
    jac.sync()
    await until(() => jac.status().detail === undefined && jac.status().state === 'running')
    expect(jac.status().version).toBe('9.9.9')
    expect(existsSync(path.join(userDataDir, 'addons'))).toBe(false)
  })
})
