// Recorded screens, replayed: raw pty output from the real binaries at 100x30,
// with the scratch path's user name replaced.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { screenMenu, screenOpinion, screenQuestion } from '../../shared/screenOpinion'
import { screenRows } from './screenRows'

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')

describe('reading a recorded screen', () => {
  it('reads claude asking to trust a new folder', async () => {
    const rows = await screenRows(fixture('claude-trust.txt'), 100, 30)
    expect(rows).toContain(' ❯ No, exit')
    expect(screenOpinion('claude', rows)).toBe('waiting')
    expect(screenQuestion('claude', rows)).toBe('Trust this folder?')
    expect(screenMenu('claude', rows)?.choices).toEqual([
      { label: 'Trust', keys: ['\u001b[B', '\r'] },
      { label: 'Exit', keys: ['\r'] }
    ])
  })

  it('reads codex asking to trust a new repository', async () => {
    const rows = await screenRows(fixture('codex-trust.txt'), 100, 30)
    expect(screenOpinion('codex', rows)).toBe('waiting')
    expect(screenQuestion('codex', rows)).toBe('Trust this directory?')
    expect(screenMenu('codex', rows)?.choices).toEqual([
      { label: 'Trust', keys: ['\r'] },
      { label: 'Exit', keys: ['2'] }
    ])
  })

  it('reads claude asking permission for a tool call', async () => {
    const rows = await screenRows(fixture('claude-permission.txt'), 100, 30)
    expect(rows.some((row) => row.includes('Do you want to proceed?'))).toBe(true)
    expect(screenOpinion('claude', rows)).toBe('waiting')
    expect(screenQuestion('claude', rows)).toBe('Allow command: mkdir -p out && touch out/hello.txt?')
    expect(screenMenu('claude', rows)?.choices).toEqual([
      { label: 'Yes', keys: ['\r'] },
      { label: 'Yes, Always', keys: ['2'] },
      { label: 'No…', keys: null }
    ])
  })

  it('offers no answers to a shell showing a recorded menu', async () => {
    const rows = await screenRows(fixture('claude-permission.txt'), 100, 30)
    expect(screenMenu(undefined, rows)).toBeNull()
  })

  it('has no opinion once the same words have scrolled up the screen', async () => {
    const more = Array.from({ length: 6 }, (_, index) => `\r\nline ${index}`).join('')
    const rows = await screenRows(`${fixture('claude-trust.txt')}\x1b[30;1H${more}`, 100, 30)
    expect(rows.some((row) => row.includes('Enter to confirm · Esc to cancel'))).toBe(true)
    expect(screenOpinion('claude', rows)).toBeNull()
  })

  it('reads only the visible screen, not what scrolled off it', async () => {
    const rows = await screenRows('Press enter to continue\r\n' + 'x\r\n'.repeat(40), 100, 10)
    expect(rows).toHaveLength(10)
    expect(rows.some((row) => row.includes('Press enter'))).toBe(false)
  })
})
