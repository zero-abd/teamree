// What "Open in …" does, and what it says when it cannot. Nothing here starts
// a program; the argv assertion is the load-bearing one.

import { describe, expect, it } from 'vitest'
import { createEditorActions, findAppsOnMac, KNOWN_APPS, type EditorDeps } from './openInEditor'

const CHECKOUT = '/repos/pager-wt/rewrite-the-pager'
const FILE = `${CHECKOUT}/src/pager.ts`

/** The spawner, replaced by a notebook. */
function recorder(throwing?: Error): {
  started: { binary: string; args: readonly string[] }[]
  start: (binary: string, args: readonly string[]) => void
} {
  const started: { binary: string; args: readonly string[] }[] = []
  return {
    started,
    start: (binary, args) => {
      if (throwing) throw throwing
      started.push({ binary, args })
    }
  }
}

/** A machine with these apps installed, by bundle id, and these programs on PATH. */
function machine(
  apps: Record<string, string>,
  ...onPath: string[]
): Pick<EditorDeps, 'findApps' | 'locate' | 'isDirectory'> {
  return {
    findApps: async () => new Map(Object.entries(apps)),
    locate: (command) => (onPath.includes(command) ? `/usr/local/bin/${command}` : null),
    isDirectory: (path) => path === CHECKOUT
  }
}

const VSCODE = { 'com.microsoft.VSCode': '/Applications/Visual Studio Code.app' }
const ZED = { 'dev.zed.Zed': '/Applications/Zed.app' }
const ITERM = { 'com.googlecode.iterm2': '/Applications/iTerm.app' }
const FINDER = { 'com.apple.finder': '/System/Library/CoreServices/Finder.app' }

describe('an app teamree can find', () => {
  it('opens it with open -a, the path one argument and never a command line', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(VSCODE), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT })).toEqual({ opened: true, editor: 'VS Code' })
    expect(spawner.started).toEqual([
      { binary: '/usr/bin/open', args: ['-a', '/Applications/Visual Studio Code.app', CHECKOUT] }
    ])
  })

  it('hands a path that reads like a shell command over as one argument', async () => {
    const spawner = recorder()
    const hostile = '/repos/$(rm -rf ~) & echo'
    const actions = createEditorActions({ ...machine(ZED), start: spawner.start })

    expect(await actions.open({ path: hostile })).toEqual({ opened: true, editor: 'Zed' })
    expect(spawner.started[0]?.args).toEqual(['-a', '/Applications/Zed.app', hostile])
  })

  it('opens the app this project picked, by bundle id', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine({ ...VSCODE, ...ZED }), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT, command: 'dev.zed.Zed' })).toEqual({ opened: true, editor: 'Zed' })
    expect(spawner.started[0]?.args).toEqual(['-a', '/Applications/Zed.app', CHECKOUT])
  })

  // A project set up before apps were detected stored the shim's name.
  it('reads a stored shim name as its app when the shim is not on PATH', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(VSCODE), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT, command: 'code' })).toEqual({ opened: true, editor: 'VS Code' })
    expect(spawner.started[0]?.binary).toBe('/usr/bin/open')
  })

  it('opens a checkout in a terminal or Finder', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine({ ...ITERM, ...FINDER }), start: spawner.start })

    await actions.open({ path: CHECKOUT, command: 'com.googlecode.iterm2' })
    await actions.open({ path: CHECKOUT, command: 'com.apple.finder' })

    expect(spawner.started.map((run) => run.args)).toEqual([
      ['-a', '/Applications/iTerm.app', CHECKOUT],
      ['-a', '/System/Library/CoreServices/Finder.app', CHECKOUT]
    ])
  })

  // A terminal handed a file runs it.
  it('never hands a terminal a file', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(ITERM), start: spawner.start })

    const result = await actions.open({ path: FILE, command: 'com.googlecode.iterm2' })

    expect(result.opened).toBe(false)
    expect(spawner.started).toEqual([])
  })

  it('opens a file in an editor', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(ZED), start: spawner.start })

    expect(await actions.open({ path: FILE })).toEqual({ opened: true, editor: 'Zed' })
  })

  it('defaults to the first editor in its own order, never a terminal', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine({ ...ITERM, ...ZED, ...VSCODE }), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT })).toEqual({ opened: true, editor: 'VS Code' })
  })

  it('lists editors, then terminals, then Finder, and nothing it did not find', async () => {
    const actions = createEditorActions({
      ...machine({ ...FINDER, ...ITERM, ...ZED }, 'code'),
      start: recorder().start
    })

    expect(await actions.list()).toEqual({
      editors: [
        { command: 'code', label: 'VS Code', kind: 'editor' },
        { command: 'dev.zed.Zed', label: 'Zed', kind: 'editor' },
        { command: 'com.googlecode.iterm2', label: 'iTerm', kind: 'terminal' },
        { command: 'com.apple.finder', label: 'Finder', kind: 'finder' }
      ]
    })
  })

  it('prefers the app to its shim', async () => {
    const actions = createEditorActions({ ...machine(VSCODE, 'code'), start: recorder().start })

    expect((await actions.list()).editors).toEqual([
      { command: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor' }
    ])
  })

  it('looks once per run', async () => {
    let looks = 0
    const actions = createEditorActions({
      ...machine(ZED),
      findApps: async () => {
        looks += 1
        return new Map(Object.entries(ZED))
      },
      start: recorder().start
    })

    await actions.list()
    await actions.open({ path: CHECKOUT })
    expect(looks).toBe(1)
  })
})

describe('a program named in Settings', () => {
  it('runs the command this project names on PATH, path as its one argument', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(VSCODE, 'mate'), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT, command: 'mate' })).toEqual({ opened: true, editor: 'mate' })
    expect(spawner.started).toEqual([{ binary: '/usr/local/bin/mate', args: [CHECKOUT] }])
  })

  it('is not quietly swapped for another when missing', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(VSCODE), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT, command: 'mate' })).toEqual({ opened: false, reason: 'mate not found' })
    expect(spawner.started).toEqual([])
  })
})

describe('nothing to open with', () => {
  it('refuses when no editor is installed', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(ITERM), start: spawner.start })

    expect(await actions.open({ path: CHECKOUT })).toEqual({ opened: false, reason: 'no editor found' })
    expect(spawner.started).toEqual([])
  })

  it('refuses a relative path rather than resolving it against wherever the app was launched from', async () => {
    const spawner = recorder()
    const actions = createEditorActions({ ...machine(VSCODE), start: spawner.start })

    expect((await actions.open({ path: 'rewrite-the-pager' })).opened).toBe(false)
    expect(spawner.started).toEqual([])
  })

  it('answers a spawn that threw with what went wrong, rather than throwing across the bridge', async () => {
    const actions = createEditorActions({ ...machine(VSCODE), start: recorder(new Error('EACCES')).start })

    expect(await actions.open({ path: CHECKOUT })).toEqual({ opened: false, reason: 'VS Code would not start: EACCES' })
  })
})

describe('finding apps on a Mac', () => {
  const home = '/Users/pat'

  it('checks the usual folders first and asks Spotlight only about the rest', async () => {
    const asked: string[][] = []
    const found = await findAppsOnMac(KNOWN_APPS, {
      home,
      exists: (path) => path === '/Applications/Zed.app' || path === '/System/Applications/Utilities/Terminal.app',
      spotlight: async (ids) => {
        asked.push([...ids])
        return [
          '/Users/pat/Applications/WebStorm.app   kMDItemCFBundleIdentifier = com.jetbrains.WebStorm',
          '/Users/pat/.Trash/Cursor.app   kMDItemCFBundleIdentifier = com.todesktop.230313mzl4w4u92',
          '/Applications/Xcode.app/Contents/Applications/Other.app   kMDItemCFBundleIdentifier = com.apple.dt.Xcode',
          ''
        ].join('\n')
      }
    })

    expect(Object.fromEntries(found)).toEqual({
      'dev.zed.Zed': '/Applications/Zed.app',
      'com.apple.Terminal': '/System/Applications/Utilities/Terminal.app',
      'com.jetbrains.WebStorm': '/Users/pat/Applications/WebStorm.app'
    })
    expect(asked[0]).not.toContain('dev.zed.Zed')
    expect(asked[0]).toContain('com.jetbrains.WebStorm')
  })

  it('skips Spotlight when every app was where it usually is', async () => {
    let asked = false
    await findAppsOnMac(KNOWN_APPS, {
      home,
      exists: () => true,
      spotlight: async () => {
        asked = true
        return ''
      }
    })
    expect(asked).toBe(false)
  })

  it('makes do with the folders when Spotlight fails', async () => {
    const found = await findAppsOnMac(KNOWN_APPS, {
      home,
      exists: (path) => path === '/Applications/Ghostty.app',
      spotlight: async () => {
        throw new Error('mdfind timed out')
      }
    })
    expect([...found.keys()]).toEqual(['com.mitchellh.ghostty'])
  })
})
