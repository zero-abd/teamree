// What "Open in …" does, and what it says when it cannot. Nothing here starts
// a program; the argv assertion is the load-bearing one.

import { describe, expect, it } from 'vitest'
import { createEditorActions, KNOWN_EDITORS } from './openInEditor'

const CHECKOUT = '/repos/pager-wt/rewrite-the-pager'

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

/** A machine with exactly these programs on it, at a predictable place. */
function machine(...installed: string[]): (command: string) => string | null {
  return (command) => (installed.includes(command) ? `/usr/local/bin/${command}` : null)
}

describe('an editor teamree can find', () => {
  it('starts it with the path as an argument and never as a command line', () => {
    const spawner = recorder()
    const actions = createEditorActions({ locate: machine('code'), start: spawner.start })

    const result = actions.open({ path: CHECKOUT })

    expect(result).toEqual({ opened: true, editor: 'VS Code' })
    expect(spawner.started).toEqual([{ binary: '/usr/local/bin/code', args: [CHECKOUT] }])
  })

  // A directory that reads as a shell command is a directory.
  it('hands a path that reads like a shell command over as one argument', () => {
    const spawner = recorder()
    const hostile = '/repos/$(rm -rf ~) & echo'
    const actions = createEditorActions({ locate: machine('zed'), start: spawner.start })

    expect(actions.open({ path: hostile })).toEqual({ opened: true, editor: 'Zed' })
    expect(spawner.started[0]?.args).toEqual([hostile])
  })

  it('prefers the first of its own list that is there, rather than whatever answers', () => {
    const spawner = recorder()
    const actions = createEditorActions({ locate: machine('subl', 'cursor'), start: spawner.start })

    expect(actions.open({ path: CHECKOUT })).toEqual({ opened: true, editor: 'Cursor' })
  })

  it('runs the command this project names in preference to anything found', () => {
    const spawner = recorder()
    const actions = createEditorActions({ locate: machine('code', 'mate'), start: spawner.start })

    expect(actions.open({ path: CHECKOUT, command: 'mate' })).toEqual({ opened: true, editor: 'mate' })
    expect(spawner.started).toEqual([{ binary: '/usr/local/bin/mate', args: [CHECKOUT] }])
  })

  it('lists what it found, and nothing it did not', () => {
    const actions = createEditorActions({ locate: machine('zed', 'code'), start: recorder().start })

    expect(actions.list()).toEqual({
      editors: [
        { command: 'code', label: 'VS Code' },
        { command: 'zed', label: 'Zed' }
      ]
    })
  })
})

describe('an editor teamree cannot find', () => {
  // A menu item that did nothing and said nothing would read as a broken button.
  it('refuses when nothing is configured and nothing is installed, and says what it looked for', () => {
    const spawner = recorder()
    const actions = createEditorActions({ locate: machine(), start: spawner.start })

    const result = actions.open({ path: CHECKOUT })

    expect(result.opened).toBe(false)
    if (result.opened) throw new Error('unreachable')
    for (const editor of KNOWN_EDITORS) expect(result.reason).toContain(editor.command)
    expect(result.reason).toContain('Settings')
    expect(spawner.started).toEqual([])
  })

  it('names the command this project asked for when that is the one missing', () => {
    const spawner = recorder()
    // `code` is right there and is not used: a named editor is not quietly swapped.
    const actions = createEditorActions({ locate: machine('code'), start: spawner.start })

    const result = actions.open({ path: CHECKOUT, command: 'mate' })

    expect(result).toEqual({ opened: false, reason: 'teamree could not find mate on PATH.' })
    expect(spawner.started).toEqual([])
  })

  it('refuses a relative path rather than resolving it against wherever the app was launched from', () => {
    const spawner = recorder()
    const actions = createEditorActions({ locate: machine('code'), start: spawner.start })

    const result = actions.open({ path: 'rewrite-the-pager' })

    expect(result.opened).toBe(false)
    expect(spawner.started).toEqual([])
  })

  it('answers a spawn that threw with what went wrong, rather than throwing across the bridge', () => {
    const spawner = recorder(new Error('EACCES'))
    const actions = createEditorActions({ locate: machine('code'), start: spawner.start })

    expect(actions.open({ path: CHECKOUT })).toEqual({
      opened: false,
      reason: 'VS Code would not start: EACCES'
    })
  })
})
