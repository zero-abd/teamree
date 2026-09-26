import { describe, expect, it } from 'vitest'
import type { ListeningPort, Terminal } from '@shared/entities'
import { listPorts, portChip, portClashes, portUrl } from './portChip'

function pane(id: string, worktreeId: string, ports?: ListeningPort[], running = true): Terminal {
  return {
    id,
    worktreeId,
    title: 'zsh',
    cwd: '/tmp',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running,
    busy: false,
    lastOutputAt: 0,
    ...(ports === undefined ? {} : { ports })
  }
}

const node = (port: number, pid = 100 + port): ListeningPort => ({ port, pid, command: 'node' })
const NAMES: Record<string, string> = { api: 'api-fix', web: 'web-redo' }
const nameOf = (worktreeId: string): string => NAMES[worktreeId] ?? worktreeId

describe('portUrl', () => {
  it('is localhost, whatever address the server bound', () => {
    expect(portUrl(5173)).toBe('http://localhost:5173')
  })
})

describe('listPorts', () => {
  it('lists every running pane port, lowest first, with its owner', () => {
    const terminals = [pane('b', 'web', [node(8080)]), pane('a', 'api', [node(5173), node(9229)])]
    expect(listPorts(terminals).map((entry) => [entry.port, entry.terminalId, entry.worktreeId])).toEqual([
      [5173, 'a', 'api'],
      [8080, 'b', 'web'],
      [9229, 'a', 'api']
    ])
  })

  it('leaves out an exited pane', () => {
    expect(listPorts([pane('a', 'api', [node(5173)], false)])).toEqual([])
  })
})

describe('portClashes', () => {
  it('names a port held in two worktrees', () => {
    const terminals = [
      pane('a', 'api', [node(5173)]),
      pane('b', 'web', [node(5173, 900)]),
      pane('c', 'web', [node(3000)])
    ]
    expect(portClashes(terminals)).toEqual(new Map([[5173, ['api', 'web']]]))
  })

  it('is not a clash for two panes of one worktree', () => {
    expect(portClashes([pane('a', 'api', [node(5173)]), pane('b', 'api', [node(5173, 7)])]).size).toBe(0)
  })
})

describe('portChip', () => {
  it('is nothing without a port', () => {
    expect(portChip([pane('a', 'api')], 'api', nameOf)).toBeNull()
  })

  it('shows the lowest port and opens it', () => {
    const chip = portChip([pane('a', 'api', [node(5173)])], 'api', nameOf)
    expect(chip).toMatchObject({ label: ':5173', url: 'http://localhost:5173', clash: false })
    expect(chip?.title).toBe(':5173  node')
  })

  it('counts the rest, one per distinct port, and lists each on hover', () => {
    const terminals = [
      pane('a', 'api', [node(5173), { port: 5173, pid: 7, command: 'node' }]),
      pane('b', 'api', [{ port: 8000, pid: 8, command: 'Python' }]),
      pane('c', 'web', [node(3000)])
    ]
    const chip = portChip(terminals, 'api', nameOf)
    expect(chip?.label).toBe(':5173 +1')
    expect(chip?.title).toBe(':5173  node\n:8000  Python')
  })

  it('says which other worktree holds the same port', () => {
    const terminals = [pane('a', 'api', [node(5173)]), pane('b', 'web', [node(5173, 900)])]
    const chip = portChip(terminals, 'api', nameOf)
    expect(chip?.clash).toBe(true)
    expect(chip?.title).toBe(':5173  node\n:5173 also in web-redo')
  })
})
