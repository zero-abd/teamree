import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { integrateShell, writeShellIntegration } from './shell-integration'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in CLI in `cli/`, an older one in `stale/`, and a profile that puts `stale/` first at every step. */
function rig(): { root: string; integration: string; cli: string; stale: string; user: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'teamree-integration-'))
  scratch.push(root)
  const cli = path.join(root, 'cli', 'teamree')
  const stale = path.join(root, 'stale')
  const user = path.join(root, 'user')
  for (const dir of [path.dirname(cli), stale, user]) mkdirSync(dir, { recursive: true })
  for (const [file, says] of [
    [cli, 'bundled'],
    [path.join(stale, 'teamree'), 'stale']
  ] as const) {
    writeFileSync(file, `#!/bin/sh\necho ${says}\n`)
    chmodSync(file, 0o755)
  }
  const integration = path.join(root, 'integration')
  writeShellIntegration(integration)
  return { root, integration, cli, stale, user }
}

function run(file: string, args: string[], env: Record<string, string>): string {
  return execFileSync(file, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    .trim()
    .split('\n')
    .at(-1) as string
}

const unix = process.platform === 'win32' ? describe.skip : describe

describe('integrateShell', () => {
  it('stands in for the user’s ZDOTDIR and BASH_ENV, keeping them for its own files to read', () => {
    const launched = integrateShell({ file: '/bin/zsh', args: ['-l'] }, { ZDOTDIR: '/u/zsh', BASH_ENV: '/u/env' }, '/d')
    expect(launched).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
      env: {
        ZDOTDIR: '/d/zsh',
        TEAMREE_USER_ZDOTDIR: '/u/zsh',
        BASH_ENV: '/d/bash/env.bash',
        TEAMREE_USER_BASH_ENV: '/u/env'
      }
    })
  })

  it('keeps the user’s own ZDOTDIR when the app was started inside another teamree pane', () => {
    const env = { ZDOTDIR: '/other/zsh', TEAMREE_USER_ZDOTDIR: '/u/zsh' }
    expect(integrateShell({ file: '/bin/zsh', args: ['-l'] }, env, '/d').env.TEAMREE_USER_ZDOTDIR).toBe('/u/zsh')
  })

  it('starts an interactive bash on its init file and leaves a command alone', () => {
    expect(integrateShell({ file: '/bin/bash', args: ['-l'] }, {}, '/d').args).toEqual([
      '--init-file',
      '/d/bash/init.bash'
    ])
    expect(integrateShell({ file: '/bin/bash', args: ['-c', 'claude'] }, {}, '/d').args).toEqual(['-c', 'claude'])
  })

  it('changes nothing on Windows', () => {
    const command = { file: 'cmd.exe', args: '/d' }
    expect(integrateShell(command, { PATH: 'C:\\x' }, 'C:\\d', 'win32')).toEqual({ ...command, env: { PATH: 'C:\\x' } })
  })
})

unix('the startup files', () => {
  it.runIf(process.platform === 'darwin')(
    'find the bundled CLI after every zsh startup file rebuilds PATH, reading the user’s files where their .zshenv moved them',
    () => {
      const { integration, cli, stale, user } = rig()
      const moved = path.join(user, 'conf')
      mkdirSync(moved)
      const first = `path=(${stale} $path)\n`
      writeFileSync(path.join(user, '.zshenv'), `${first}ZDOTDIR=${moved}\n`)
      for (const name of ['.zprofile', '.zlogin']) writeFileSync(path.join(moved, name), first)
      writeFileSync(path.join(moved, '.zshrc'), `${first}READ_ZSHRC=yes\n`)

      const launch = integrateShell(
        { file: '/bin/zsh', args: ['-l'] },
        { PATH: '/usr/bin:/bin', HOME: os.homedir(), TEAMREE_CLI: cli, ZDOTDIR: user },
        integration
      )
      const shell = (flags: string[]): string =>
        run(
          '/bin/zsh',
          [...flags, '-c', 'print -r -- "$(command -v teamree) ${PATH%%:*} ${READ_ZSHRC:-no}"'],
          launch.env
        )

      const found = `${cli} ${path.dirname(cli)}`
      expect(shell([])).toBe(`${found} no`)
      expect(shell(['-l'])).toBe(`${found} no`)
      expect(shell(['-l', '-i'])).toBe(`${found} yes`)
    }
  )

  it.runIf(process.platform === 'darwin')('keeps the history where the user’s shell keeps it', () => {
    const { integration, cli, user } = rig()
    const launch = integrateShell(
      { file: '/bin/zsh', args: ['-l'] },
      { PATH: '/usr/bin:/bin', HOME: os.homedir(), TEAMREE_CLI: cli, ZDOTDIR: user },
      integration
    )
    // What macOS's /etc/zshrc sets, from the ZDOTDIR it sees.
    const env = { ...launch.env, HISTFILE: path.join(integration, 'zsh', '.zsh_history') }
    expect(run('/bin/zsh', ['-i', '-c', 'print -r -- $HISTFILE'], env)).toBe(path.join(user, '.zsh_history'))
  })

  it('finds the bundled CLI from bash, login or not, after the user’s files rebuild PATH', () => {
    const { root, integration, cli, stale } = rig()
    // bash reads its login files from HOME, so this one is scratch: bash is not node and never reaches a keychain.
    const home = path.join(root, 'home')
    mkdirSync(home)
    writeFileSync(path.join(home, '.bash_profile'), `export PATH=${stale}:$PATH\n`)
    const userEnv = path.join(root, 'user-env.bash')
    writeFileSync(userEnv, `export PATH=${stale}:$PATH\n`)

    const launch = integrateShell(
      { file: '/bin/bash', args: ['-l'] },
      { PATH: '/usr/bin:/bin', HOME: home, TEAMREE_CLI: cli, BASH_ENV: userEnv },
      integration
    )
    const probe = 'echo "$(command -v teamree) ${PATH%%:*}"'
    const expected = `${cli} ${path.dirname(cli)}`
    expect(run('/bin/bash', ['-c', probe], launch.env)).toBe(expected)
    expect(run('/bin/bash', ['-l', '-c', probe], launch.env)).toBe(expected)
    expect(run('/bin/bash', [...(launch.args as string[]), '-i', '-c', probe], launch.env)).toBe(expected)
  })
})
