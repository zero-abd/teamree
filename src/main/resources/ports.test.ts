import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseLsofListeners, portsByPane, PortWatcher, type PortWatcherHost } from './ports'
import { parsePsTable } from './psTable'
import type { PaneProcess } from './resourceTree'

// `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: one `p` and `c` per process, an `f` and `n` per socket.
const LSOF = [
  'p649',
  'crapportd',
  'f10',
  'n*:53541',
  'f14',
  'n*:53541',
  'p601',
  'cnode',
  'f22',
  'n[::1]:5173',
  'f23',
  'n127.0.0.1:5173',
  'p602',
  'cPython',
  'f3',
  'n*:8000',
  'p802',
  'cnode',
  'f19',
  'n127.0.0.1:5173',
  'p900',
  'cpostgres',
  'f7',
  'n[::]:5432',
  ''
].join('\n')

const PS = [
  '  PID  PPID  %CPU    RSS COMM',
  '    1     0   0.1   8192 /sbin/launchd',
  '  500     1   2.0 409600 /Applications/teamree.app/Contents/MacOS/teamree',
  '  600   500   0.0   3072 /bin/zsh',
  '  601   600  98.7  51200 /usr/local/bin/node',
  '  602   601   4.2  10240 /usr/bin/python3',
  '  649     1   0.0   1024 /usr/libexec/rapportd',
  '  700   500   0.0   2048 /bin/zsh',
  '  800   500   0.0   2048 /bin/zsh',
  '  801   800   0.0   2048 /usr/local/bin/npm',
  '  802   801   0.0   2048 /usr/local/bin/node',
  '  900     1   0.0   1024 /usr/local/bin/postgres',
  ''
].join('\n')

const PANES: PaneProcess[] = [
  { terminalId: 't-api', worktreeId: 'w-api', pid: 600 },
  { terminalId: 't-idle', worktreeId: 'w-api', pid: 700 },
  { terminalId: 't-web', worktreeId: 'w-web', pid: 800 }
]

describe('parseLsofListeners', () => {
  it('reads each process once per port, across IPv4 and IPv6', () => {
    expect(parseLsofListeners(LSOF)).toEqual([
      { pid: 601, command: 'node', port: 5173 },
      { pid: 802, command: 'node', port: 5173 },
      { pid: 900, command: 'postgres', port: 5432 },
      { pid: 602, command: 'Python', port: 8000 },
      { pid: 649, command: 'rapportd', port: 53541 }
    ])
  })

  it('reads nothing from empty or refused output', () => {
    expect(parseLsofListeners('')).toEqual([])
    expect(parseLsofListeners("lsof: WARNING: can't stat() nfs file system\n")).toEqual([])
  })

  it('skips a name that is not a listening address', () => {
    expect(parseLsofListeners('p1\ncx\nf1\nn127.0.0.1:5000->127.0.0.1:61000\nf2\nn*:*\n')).toEqual([])
  })
})

describe('portsByPane', () => {
  it('gives each port to the pane whose tree holds its process, however deep', () => {
    const ports = portsByPane(parseLsofListeners(LSOF), parsePsTable(PS), PANES)
    expect(ports.get('t-api')).toEqual([
      { port: 5173, pid: 601, command: 'node' },
      { port: 8000, pid: 602, command: 'Python' }
    ])
    expect(ports.get('t-web')).toEqual([{ port: 5173, pid: 802, command: 'node' }])
  })

  it('leaves out panes with no ports and processes under no pane', () => {
    const ports = portsByPane(parseLsofListeners(LSOF), parsePsTable(PS), PANES)
    expect([...ports.keys()].sort()).toEqual(['t-api', 't-web'])
  })

  it('claims a listener that is the pane child itself', () => {
    const ports = portsByPane([{ pid: 700, command: 'zsh', port: 9000 }], parsePsTable(PS), PANES)
    expect(ports.get('t-idle')).toEqual([{ port: 9000, pid: 700, command: 'zsh' }])
  })

  it('stops on a parent loop rather than walking forever', () => {
    const loop = parsePsTable('  PID  PPID %CPU RSS COMM\n 10 11 0 1 a\n 11 10 0 1 b\n')
    expect(portsByPane([{ pid: 10, command: 'a', port: 1 }], loop, PANES).size).toBe(0)
  })
})

describe('PortWatcher', () => {
  let host: PortWatcherHost & { lsof: ReturnType<typeof vi.fn>; ps: ReturnType<typeof vi.fn> }
  let panes: PaneProcess[]
  let changes: number
  let watcher: PortWatcher

  beforeEach(() => {
    vi.useFakeTimers()
    host = { lsof: vi.fn(async () => LSOF), ps: vi.fn(async () => PS) }
    panes = [...PANES]
    changes = 0
    watcher = new PortWatcher({
      panes: () => panes,
      onChange: () => changes++,
      host,
      debounceMs: 500,
      minGapMs: 2000,
      intervalMs: 5000
    })
  })

  afterEach(() => {
    watcher.close()
    vi.useRealTimers()
  })

  it('runs nothing while no pane runs', async () => {
    panes = []
    watcher.poke()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.lsof).not.toHaveBeenCalled()
    expect(host.ps).not.toHaveBeenCalled()
  })

  it('folds a burst of pokes into one scan', async () => {
    for (let i = 0; i < 10; i++) watcher.poke()
    await vi.advanceTimersByTimeAsync(499)
    expect(host.lsof).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.lsof).toHaveBeenCalledTimes(1)
    expect(watcher.ports('t-api')?.map((entry) => entry.port)).toEqual([5173, 8000])
    expect(changes).toBe(1)
  })

  it('scans at most once per gap however often poked', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    for (let at = 0; at < 4_000; at += 100) {
      watcher.poke()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(host.lsof).toHaveBeenCalledTimes(3)
  })

  it('polls while a pane runs and stops once none does', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.lsof).toHaveBeenCalledTimes(3)
    panes = []
    await vi.advanceTimersByTimeAsync(5_000)
    expect(watcher.ports('t-api')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.lsof).toHaveBeenCalledTimes(3)
  })

  it('announces only a change', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(changes).toBe(1)
    host.lsof.mockResolvedValue('')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(changes).toBe(2)
    expect(watcher.ports('t-api')).toBeUndefined()
  })

  it('names a process by its executable where the host can say, not by its thread', async () => {
    host.lsof.mockResolvedValue(LSOF.replace('p601\ncnode', 'p601\ncMainThread'))
    const executable = vi.fn((pid: number) => (pid === 601 ? 'node' : undefined))
    watcher = new PortWatcher({
      panes: () => panes,
      onChange: () => {},
      host: { ...host, executable },
      debounceMs: 500
    })
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    expect(watcher.ports('t-api')?.map((entry) => entry.command)).toEqual(['node', 'Python'])
    expect(executable).not.toHaveBeenCalledWith(649)
  })

  it('skips ps when nothing listens', async () => {
    host.lsof.mockResolvedValue('')
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    expect(host.lsof).toHaveBeenCalledTimes(1)
    expect(host.ps).not.toHaveBeenCalled()
  })

  it('reads a failed lsof as no ports', async () => {
    host.lsof.mockRejectedValue(new Error('sandboxed'))
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    expect(watcher.ports('t-api')).toBeUndefined()
    expect(changes).toBe(0)
  })

  it('ignores pokes raised by its own announcement', async () => {
    watcher = new PortWatcher({ panes: () => panes, onChange: () => watcher.poke(), host, debounceMs: 500 })
    watcher.poke()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(host.lsof).toHaveBeenCalledTimes(1)
  })
})
