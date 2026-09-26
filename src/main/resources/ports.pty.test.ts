// A real pane, a real server in it, a real lsof: the port reaches `terminal.list` and leaves with the server.

import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalService, type TerminalService } from '../terminals/method-handlers'
import { canSpawnPty, waitUntil } from '../terminals/pty-test-support'
import { PortWatcher } from './ports'

const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip
const WORKTREE = 'wt_ports'
const SERVER = `require('http').createServer().listen(0, '127.0.0.1', function () { console.log('port=' + this.address().port + ' pid=' + process.pid) }); setTimeout(() => process.exit(0), 3000)`

let service: TerminalService | undefined
let watcher: PortWatcher | undefined

afterEach(async () => {
  watcher?.close()
  await service?.shutdown()
})

describePty('ports in a pane', () => {
  it('finds the port a pane listens on and drops it when the server exits', async () => {
    let current: PortWatcher | undefined
    service = createTerminalService({
      resolveWorktreeCwd: () => process.cwd(),
      ports: (terminalId) => current?.ports(terminalId)
    })
    const manager = service.manager
    current = watcher = new PortWatcher({
      panes: () => manager.paneProcesses(),
      onChange: () => {},
      debounceMs: 50,
      minGapMs: 100,
      intervalMs: 200
    })
    const pane = await service.handlers['terminal.create']({ worktreeId: WORKTREE })
    manager.write(pane.id, `'${process.execPath}' -e "${SERVER}"\r`, false)
    watcher.poke()

    await waitUntil(() => (manager.list(WORKTREE)[0]?.ports?.length ?? 0) > 0, 'the port to appear', 8_000)
    const printed = /port=(\d+) pid=(\d+)/.exec(manager.read(pane.id))
    expect(manager.list(WORKTREE)[0]?.ports).toEqual([
      { port: Number(printed?.[1]), pid: Number(printed?.[2]), command: expect.any(String) }
    ])

    // Every snapshot carries them, or a resize's answer would wipe the row's chip.
    const resized = await service.handlers['terminal.resize']({ terminalId: pane.id, cols: 100, rows: 30 })
    expect(resized.ports?.map((entry) => entry.port)).toEqual([Number(printed?.[1])])

    await waitUntil(() => manager.list(WORKTREE)[0]?.ports === undefined, 'the port to go', 8_000)
  }, 20_000)
})
