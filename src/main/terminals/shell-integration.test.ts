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

  it('leaves the user’s ZDOTDIR out when they have none, rather than calling it empty', () => {
    const launched = integrateShell({ file: '/bin/zsh', args: ['-l'] }, { TEAMREE_USER_ZDOTDIR: '/stale' }, '/d')
    expect(launched.env).not.toHaveProperty('TEAMREE_USER_ZDOTDIR')
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
  const ZSH_STARTUPS: Array<[string, string[]]> = [
    ['an interactive login zsh', ['-l', '-i']],
    ['an interactive zsh', ['-i']],
    ['a login zsh', ['-l']],
    ['zsh -c', []]
  ]

  it.runIf(process.platform === 'darwin').each(ZSH_STARTUPS)(
    'hands %s the user’s ZDOTDIR back after startup, with the bundled CLI first on PATH',
    (_, flags) => {
      const { root, integration, cli, stale, user } = rig()
      const first = `path=(${stale} $path)\n`
      for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(path.join(user, name), first)
      // Unset, zsh reads the user's files from HOME; bash and zsh are not node and never reach a keychain.
      const home = path.join(root, 'home')
      mkdirSync(home)
      for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(path.join(home, name), first)
      const probe = 'print -r -- "${ZDOTDIR-unset} $(command -v teamree) ${PATH%%:*} ${+TEAMREE_USER_ZDOTDIR}"'
      const after = (zdotdir: string | undefined): string => {
        const base = { PATH: '/usr/bin:/bin', HOME: home, TEAMREE_CLI: cli }
        const launch = integrateShell(
          { file: '/bin/zsh', args: ['-l'] },
          zdotdir === undefined ? base : { ...base, ZDOTDIR: zdotdir },
          integration
        )
        return run('/bin/zsh', [...flags, '-c', probe], launch.env)
      }
      const found = `${cli} ${path.dirname(cli)} 0`
      expect(after(user)).toBe(`${user} ${found}`)
      expect(after(undefined)).toBe(`unset ${found}`)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'reads the user’s files where their .zshenv moved ZDOTDIR, and leaves it there',
    () => {
      const { integration, cli, stale, user } = rig()
      const moved = path.join(user, 'conf')
      mkdirSync(moved)
      writeFileSync(path.join(user, '.zshenv'), `ZDOTDIR=${moved}\n`)
      writeFileSync(path.join(moved, '.zshrc'), `path=(${stale} $path)\nREAD_ZSHRC=yes\n`)
      const launch = integrateShell(
        { file: '/bin/zsh', args: ['-l'] },
        { PATH: '/usr/bin:/bin', HOME: os.homedir(), TEAMREE_CLI: cli, ZDOTDIR: user },
        integration
      )
      const said = run(
        '/bin/zsh',
        ['-l', '-i', '-c', 'print -r -- "$ZDOTDIR $(command -v teamree) $READ_ZSHRC"'],
        launch.env
      )
      expect(said).toBe(`${moved} ${cli} yes`)
    }
  )

  // The cost of handing ZDOTDIR back: a nested zsh runs only the user's files and keeps their PATH order.
  // A login one also runs path_helper, which puts /usr/local/bin ahead; $TEAMREE_CLI names the CLI regardless.
  it.runIf(process.platform === 'darwin')(
    'leaves a zsh started inside the pane the CLI on PATH, first unless the user’s files put another ahead',
    () => {
      const { root, integration, cli, stale, user } = rig()
      const other = path.join(root, 'other')
      mkdirSync(other)
      const env = integrateShell(
        { file: '/bin/zsh', args: ['-l'] },
        { PATH: '/usr/bin:/bin', HOME: os.homedir(), TEAMREE_CLI: cli, ZDOTDIR: user },
        integration
      ).env
      const nested = (dir: string, inner: string): string => {
        writeFileSync(path.join(user, '.zshenv'), `path=(${dir} $path)\n`)
        return run('/bin/zsh', ['-l', '-i', '-c', inner], env)
      }
      expect(nested(other, 'zsh -c "command -v teamree"')).toBe(cli)
      expect(nested(stale, 'zsh -c "command -v teamree"')).toBe(path.join(stale, 'teamree'))
      const [index, named] = nested(other, "zsh -lc 'print -r -- ${path[(I)${TEAMREE_CLI:h}]} $TEAMREE_CLI'").split(' ')
      expect(Number(index)).toBeGreaterThan(0)
      expect(named).toBe(cli)
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
