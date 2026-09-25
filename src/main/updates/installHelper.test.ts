// The script that swaps bundles after the app has quit, run for real with /bin/sh against a
// temporary folder, with a stand-in for `open` that records what it was asked to launch.

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { helperScript, shellQuote, type HelperOptions } from './installHelper'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teamree-helper-it's "))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A bundle whose only content is a marker naming which copy it is. */
function bundle(path: string, marker: string): void {
  mkdirSync(join(path, 'Contents'), { recursive: true })
  writeFileSync(join(path, 'Contents', 'marker'), marker)
}

function marker(path: string): string | null {
  const file = join(path, 'Contents', 'marker')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Records each launch; refuses to launch a copy whose marker is `refuse`. */
function opener(refuse: string | null = null): { path: string; calls: () => string[] } {
  const path = join(root, 'open')
  const record = join(root, 'opened')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${shellQuote(record)}`,
      'for last; do :; done',
      refuse === null ? '' : `[ "$(cat "$last/Contents/marker")" = ${shellQuote(refuse)} ] && exit 1`,
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return { path, calls: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : []) }
}

function setup(options: Partial<HelperOptions> = {}): HelperOptions {
  const applications = join(root, 'Applications')
  const staging = join(root, 'updates', '0.3.0')
  bundle(join(applications, 'teamree.app'), 'old')
  bundle(join(staging, 'teamree.app'), 'new')
  return {
    pid: 999_999,
    target: join(applications, 'teamree.app'),
    staged: join(staging, 'teamree.app'),
    log: join(root, 'updates', 'update.log'),
    version: '0.3.0',
    foreground: true,
    opener: '/usr/bin/open',
    ...options
  }
}

function run(options: HelperOptions): number | null {
  const script = join(root, 'install.sh')
  writeFileSync(script, helperScript(options))
  return spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 20_000 }).status
}

describe('the install helper', () => {
  it('is a script sh can parse', () => {
    const script = join(root, 'install.sh')
    writeFileSync(script, helperScript(setup()))
    expect(spawnSync('/bin/sh', ['-n', script]).status).toBe(0)
  })

  it('puts the new copy where the old one was, opens it in front, and removes the old one', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    expect(run(options)).toBe(0)

    expect(marker(options.target)).toBe('new')
    expect(existsSync(options.staged)).toBe(false)
    expect(readdirSync(join(root, 'Applications'))).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
    expect(readFileSync(options.log, 'utf8')).toMatch(/installed 0\.3\.0/)
  })

  it('opens in the background unless a person asked for the restart', () => {
    const open = opener()
    const options = setup({ opener: open.path, foreground: false })
    expect(run(options)).toBe(0)
    expect(open.calls()).toEqual([`-g ${options.target}`])
  })

  it('puts the old copy back and opens it when the new one will not open', () => {
    const open = opener('new')
    const options = setup({ opener: open.path })
    expect(run(options)).toBe(1)

    expect(marker(options.target)).toBe('old')
    expect(readdirSync(join(root, 'Applications'))).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target, options.target])
    expect(readFileSync(options.log, 'utf8')).toMatch(/previous copy/)
  })

  it('leaves the old copy alone and reopens it when there is nothing staged', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    rmSync(options.staged, { recursive: true })
    expect(run(options)).toBe(1)
    expect(marker(options.target)).toBe('old')
    expect(open.calls()).toEqual([options.target])
  })

  it('clears the quarantine attribute on what it installs', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    const file = join(options.staged, 'Contents', 'marker')
    spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;teamree;', file])
    expect(spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file]).status).toBe(0)

    expect(run(options)).toBe(0)
    const installed = join(options.target, 'Contents', 'marker')
    expect(spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', installed]).status).not.toBe(0)
  })

  it('touches nothing until the app has exited', async () => {
    const open = opener()
    const app = spawn('/bin/sleep', ['30'])
    const options = setup({ opener: open.path, pid: app.pid as number })
    const script = join(root, 'install.sh')
    writeFileSync(script, helperScript(options))
    const helper = spawn('/bin/sh', [script])
    const done = new Promise<number | null>((resolve) => helper.on('exit', resolve))

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(marker(options.target)).toBe('old')
    expect(open.calls()).toEqual([])

    app.kill()
    expect(await done).toBe(0)
    expect(marker(options.target)).toBe('new')
  })
})

describe('quoting for sh', () => {
  it('survives quotes, spaces and dollars', () => {
    const value = `it's a $HOME "path"`
    expect(spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }).stdout).toBe(value)
  })
})
