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

/** A whole bundle (Info.plist naming an executable that is there) plus a marker naming which copy it is. */
function bundle(path: string, marker: string): void {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(path, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>fake</string></dict></plist>\n'
  )
  writeFileSync(join(path, 'Contents', 'MacOS', 'fake'), '#!/bin/sh\n')
  chmodSync(join(path, 'Contents', 'MacOS', 'fake'), 0o755)
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

/**
 * Runs the helper; `fail` names sources the helper's `mv` refuses to move, a trailing `*` matching a prefix.
 * `half` does, once, what an interrupted cross-volume move leaves: part of the source copied, part of it deleted.
 */
function run(options: HelperOptions, faults: { fail?: string[]; half?: string } = {}): number | null {
  const script = join(root, 'install.sh')
  let text = helperScript(options)
  if (faults.fail !== undefined || faults.half !== undefined) {
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const cases = (faults.fail ?? []).map(
      (from) => `  ${from.endsWith('*') ? `${shellQuote(from.slice(0, -1))}*` : shellQuote(from)}) exit 1 ;;`
    )
    if (faults.half !== undefined) {
      const once = shellQuote(join(root, 'half-done'))
      cases.push(
        `  ${shellQuote(faults.half)}) [ -e ${once} ] || { : > ${once}; mkdir -p "$2/Contents"; rm -rf "$1/Contents/MacOS"; exit 1; } ;;`
      )
    }
    writeFileSync(join(bin, 'mv'), ['#!/bin/sh', 'case "$1" in', ...cases, 'esac', 'exec /bin/mv "$@"', ''].join('\n'))
    chmodSync(join(bin, 'mv'), 0o755)
    text = text.replace('PATH=/usr/bin:', `PATH=${shellQuote(bin)}:/usr/bin:`)
  }
  writeFileSync(script, text)
  return spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 20_000 }).status
}

/** What the Applications folder holds once the helper is done. */
function applications(): string[] {
  return readdirSync(join(root, 'Applications'))
}

// The helper calls plutil and xattr, which only macOS has.
describe.runIf(process.platform === 'darwin')('the install helper', () => {
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

  it('keeps the old copy, reopens it and keeps the update staged when the old copy will not move', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    expect(run(options, { fail: [options.target] })).toBe(1)

    expect(marker(options.target)).toBe('old')
    expect(marker(options.staged)).toBe('new')
    expect(applications()).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
    expect(readFileSync(options.log, 'utf8')).toMatch(/could not move .* aside/)
  })

  it('installs the new copy when the old one is already gone, instead of losing both', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    rmSync(options.target, { recursive: true })
    expect(run(options)).toBe(0)

    expect(marker(options.target)).toBe('new')
    expect(applications()).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
    expect(readFileSync(options.log, 'utf8')).toMatch(/missing[\s\S]*installed 0\.3\.0/)
  })

  it('installs the new copy when moving the old one aside stopped halfway', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    expect(run(options, { half: options.target })).toBe(1)

    expect(marker(options.target)).toBe('new')
    expect(existsSync(join(options.target, 'Contents', 'MacOS', 'fake'))).toBe(true)
    expect(applications()).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
  })

  it('puts the old copy back when the new one will not move into place', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    expect(run(options, { fail: [join(root, 'Applications', '.teamree-update-*')] })).toBe(1)

    expect(marker(options.target)).toBe('old')
    expect(applications()).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
  })

  it('keeps the new copy in place when it will not open and the old one cannot come back', () => {
    const open = opener('new')
    const options = setup({ opener: open.path })
    expect(run(options, { fail: [join(root, 'Applications', '.teamree-previous-*')] })).toBe(1)

    expect(marker(options.target)).not.toBeNull()
    expect(applications()).toContain('teamree.app')
  })

  it('refuses a staged copy that is not a whole bundle, and leaves the old one where it is', () => {
    const open = opener()
    const options = setup({ opener: open.path })
    rmSync(join(options.staged, 'Contents', 'MacOS'), { recursive: true })
    expect(run(options)).toBe(1)

    expect(marker(options.target)).toBe('old')
    expect(applications()).toEqual(['teamree.app'])
    expect(open.calls()).toEqual([options.target])
  })

  it('relaunches with the profile it was started with', () => {
    const open = opener()
    const options = setup({ opener: open.path, foreground: false, env: { TEAMREE_USER_DATA_DIR: "/tmp/it's here" } })
    expect(run(options)).toBe(0)
    expect(open.calls()).toEqual([`-g --env TEAMREE_USER_DATA_DIR=/tmp/it's here ${options.target}`])
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
