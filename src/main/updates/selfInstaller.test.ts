// The checks made while the app still runs, against a real folder: the swap's smallest steps, tried and undone.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relaunchOptions, SelfInstaller, swapBlock } from './selfInstaller'

let root: string
let bundle: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'teamree-preflight-'))
  bundle = join(root, 'Applications', 'teamree.app')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
})

afterEach(() => {
  spawnSync('/usr/bin/chflags', ['-R', 'nouchg', root])
  chmodSync(join(root, 'Applications'), 0o755)
  rmSync(root, { recursive: true, force: true })
})

describe('whether the swap would go through', () => {
  it('finds nothing in the way of a bundle it can replace, and leaves nothing behind', async () => {
    expect(await swapBlock(bundle)).toBeNull()
    expect(readdirSync(join(root, 'Applications'))).toEqual(['teamree.app'])
    expect(readdirSync(join(bundle, 'Contents'))).toEqual(['MacOS'])
  })

  it('says macOS refused, with the way to Settings, when the bundle cannot be written', async () => {
    expect(spawnSync('/usr/bin/chflags', ['uchg', join(bundle, 'Contents')]).status).toBe(0)
    expect(await swapBlock(bundle)).toEqual({ problem: expect.stringMatching(/macOS/), settings: true })
  })

  it('says the folder is read-only, with no Settings, when nothing can be moved in it', async () => {
    chmodSync(join(root, 'Applications'), 0o555)
    expect(await swapBlock(bundle)).toEqual({ problem: expect.stringContaining('Applications'), settings: false })
  })

  it('lets a restart put the update where a missing copy was', async () => {
    rmSync(bundle, { recursive: true })
    expect(await swapBlock(bundle)).toBeNull()
    expect(existsSync(bundle)).toBe(false)
  })
})

describe('the relaunch', () => {
  it('comes back in front when a person asked, on the default profile', () => {
    expect(relaunchOptions({}, true)).toEqual({ foreground: true, env: {} })
  })

  it('brings a throwaway profile back as itself, and a background launch back in the background', () => {
    const env = {
      TEAMREE_USER_DATA_DIR: '/tmp/p',
      TEAMREE_WORKTREES_ROOT: '/tmp/w',
      TEAMREE_BACKGROUND_LAUNCH: '1',
      HOME: '/x'
    }
    expect(relaunchOptions(env, true)).toEqual({
      foreground: false,
      env: { TEAMREE_USER_DATA_DIR: '/tmp/p', TEAMREE_WORKTREES_ROOT: '/tmp/w', TEAMREE_BACKGROUND_LAUNCH: '1' }
    })
  })
})

describe('the keys a manifest may be signed with', () => {
  it('are the shipped ones outside the test runner', () => {
    const vitest = process.env['VITEST']
    delete process.env['VITEST']
    try {
      expect(() => new SelfInstaller({ bundlePath: bundle, stagingRoot: root, trustedKeys: [] })).toThrow(/tests/)
    } finally {
      process.env['VITEST'] = vitest
    }
  })
})
