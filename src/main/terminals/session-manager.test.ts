import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout, Terminal } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import type { TerminalEvent } from '../../shared/methods'
import { findShippedCli } from '../cli/shippedCli'
import { createTerminalService, registerTerminalHandlers } from './method-handlers'
import { TerminalSessionManager } from './session-manager'
import type { MethodRegistry, StreamChannel, TerminalService } from './method-handlers'
import { isProcessAlive } from './process-tree'
import { canSpawnPty, printThenExit, waitUntil, writeFakeAgent, writeProcessTreeProbe } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { isTerminalServiceError } from './service-error'
import { writeShellIntegration } from './shell-integration'

// Driven through the handler surface the runtime will call, over real PTYs.
const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const WORKTREE = 'wt_alpha'
const services: TerminalService[] = []
const scratchDirs: string[] = []
const published: Array<{ subscription: string; event: TerminalEvent }> = []

function newService(): TerminalService {
  const service = createTerminalService({
    publish: (subscription, event) => published.push({ subscription, event }),
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? process.cwd() : undefined)
  })
  services.push(service)
  return service
}

/** A pane on this platform's own shell: stays open, echoes what is typed, on Windows as on unix. */
function newTerminal(service: TerminalService, command?: string): Promise<Terminal> {
  return service.handlers['terminal.create']({
    worktreeId: WORKTREE,
    ...(command === undefined ? {} : { command })
  })
}

afterEach(async () => {
  published.length = 0
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describePty('terminal handlers', () => {
  it(
    'creates a terminal and gives it the whole layout',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      expect(terminal).toMatchObject({ worktreeId: WORKTREE, cwd: process.cwd(), running: true })
      expect(await service.handlers['terminal.list']({})).toHaveLength(1)

      const layout = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(layout).toEqual({
        worktreeId: WORKTREE,
        root: { kind: 'leaf', terminalId: terminal.id },
        focusedTerminalId: terminal.id
      })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts each pane told the tone of the ground it prints on',
    async () => {
      let tone: 'light' | 'dark' = 'light'
      const service = createTerminalService({
        resolveWorktreeCwd: () => process.cwd(),
        colorTone: () => tone
      })
      services.push(service)
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-fgbg-'))
      scratchDirs.push(scratch)
      const script = path.join(scratch, 'fgbg.cjs')
      await writeFile(script, "console.log('fgbg=' + process.env.COLORFGBG)\nsetInterval(() => {}, 1000)\n", 'utf8')
      const command = `"${process.execPath}" "${script}"`

      const printed = async (terminalId: string): Promise<string> => {
        let found = ''
        await waitUntil(async () => {
          const { data } = await service.handlers['terminal.read']({ terminalId })
          found = /fgbg=([\d;]+)/.exec(data)?.[1] ?? ''
          return found !== ''
        }, 'the pane to print its COLORFGBG')
        return found
      }

      expect(await printed((await newTerminal(service, command)).id)).toBe('0;15')
      tone = 'dark'
      expect(await printed((await newTerminal(service, command)).id)).toBe('15;0')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'tells each pane its own terminal, worktree and project, and the app it belongs to',
    async () => {
      const service = createTerminalService({
        resolveWorktreeCwd: () => process.cwd(),
        paneIdentity: { endpoint: '/tmp/this-app.sock', cli: '/app/cli/teamree', projectOf: () => 'p_api' }
      })
      services.push(service)
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-identity-'))
      scratchDirs.push(scratch)
      const script = path.join(scratch, 'identity.cjs')
      const names = ['TERMINAL_ID', 'WORKTREE_ID', 'PROJECT_ID', 'ENDPOINT', 'CLI']
      await writeFile(
        script,
        `console.log('id=' + ${JSON.stringify(names)}.map((n) => process.env['TEAMREE_' + n]).join(','))\n` +
          'setInterval(() => {}, 1000)\n',
        'utf8'
      )
      const pane = await newTerminal(service, `"${process.execPath}" "${script}"`)

      let printed = ''
      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: pane.id })
        printed = /id=(\S+)/.exec(data)?.[1] ?? ''
        return printed !== ''
      }, 'the pane to print who it is')
      expect(printed).toBe(`${pane.id},${WORKTREE},p_api,/tmp/this-app.sock,/app/cli/teamree`)
    },
    TEST_TIMEOUT_MS
  )

  it.runIf(process.platform !== 'win32').each([
    ['a checkout', false],
    ['a packaged app', true]
  ])(
    'finds this build’s CLI first on a pane’s PATH when run from %s',
    async (_, packaged) => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-pane-cli-'))
      scratchDirs.push(scratch)
      const resources = path.join(scratch, 'Resources')
      await mkdir(path.join(resources, 'cli'), { recursive: true })
      await writeFile(path.join(resources, 'cli', 'teamree'), '#!/bin/sh\n', { mode: 0o755 })
      const cli = findShippedCli(packaged ? { resourcesPath: resources } : {})
      expect(cli?.packaged).toBe(packaged)
      const integration = path.join(scratch, 'integration')
      writeShellIntegration(integration)

      const service = createTerminalService({
        resolveWorktreeCwd: () => process.cwd(),
        paneIdentity: { cli: cli?.path as string, shellIntegrationDir: integration }
      })
      services.push(service)
      const pane = await newTerminal(service, `printf 'cli=%s\\n' "$(command -v teamree)"; sleep 5`)
      let found = ''
      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: pane.id })
        found = /cli=(\S+)/.exec(data)?.[1] ?? ''
        return found !== ''
      }, 'the pane to say where teamree is')
      expect(found).toBe(cli?.path)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'puts a prefix before the first prompt of a worktree that has one, and only there',
    async () => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-prefix-'))
      scratchDirs.push(scratch)
      const agent = await writeFakeAgent(scratch)
      const service = createTerminalService({
        resolveWorktreeCwd: () => process.cwd(),
        promptPrefix: (worktreeId) => (worktreeId === 'wt_child' ? '[teamree] Child task' : undefined)
      })
      services.push(service)
      const said = async (worktreeId: string): Promise<string> => {
        const pane = await service.handlers['terminal.create']({ worktreeId, command: agent, prompt: 'Fix it' })
        let data = ''
        await waitUntil(async () => {
          data = (await service.handlers['terminal.read']({ terminalId: pane.id })).data
          return data.includes('Fix it')
        }, 'the agent to print its prompt')
        return data
      }
      expect(await said('wt_child')).toContain('[teamree] Child task')
      expect(await said('wt_top')).not.toContain('[teamree]')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'numbers a worktree’s panes of one program from 1, counting only the panes still open',
    async () => {
      const service = newService()
      const first = await newTerminal(service)
      const second = await newTerminal(service)
      await service.handlers['terminal.close']({ terminalId: first.id })
      const { terminal: third } = await service.handlers['terminal.split']({ terminalId: second.id, direction: 'row' })
      const elsewhere = await service.handlers['terminal.create']({ worktreeId: 'wt_other', cwd: process.cwd() })

      expect([first.ordinal, second.ordinal, third.ordinal]).toEqual([1, 2, 3])
      expect(elsewhere.ordinal).toBe(1)
      const listed = await service.handlers['terminal.list']({ worktreeId: WORKTREE })
      expect(listed.map((terminal) => terminal.ordinal)).toEqual([2, 3])

      await service.handlers['terminal.close']({ terminalId: second.id })
      await service.handlers['terminal.close']({ terminalId: third.id })
      expect((await newTerminal(service)).ordinal).toBe(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'scopes the list to one worktree',
    async () => {
      const service = newService()
      const mine = await newTerminal(service)
      await service.handlers['terminal.create']({ worktreeId: 'wt_other', cwd: process.cwd() })

      const scoped = await service.handlers['terminal.list']({ worktreeId: WORKTREE })
      expect(scoped.map((terminal) => terminal.id)).toEqual([mine.id])
      expect(await service.handlers['terminal.list']({})).toHaveLength(2)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'writes to a terminal and reads it back',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      expect(await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'round-trip\n' })).toEqual({
        written: true
      })
      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: terminal.id })
        return data.includes('round-trip')
      }, 'the written text to come back')

      const tail = await service.handlers['terminal.read']({ terminalId: terminal.id, tailBytes: 4 })
      expect(Buffer.byteLength(tail.data, 'utf8')).toBeLessThanOrEqual(4)
    },
    TEST_TIMEOUT_MS
  )

  // A view mounting on a dead pane has to know before any exit event could tell it.
  it(
    'says in the snapshot whether the pane has exited',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      expect((await service.handlers['terminal.read']({ terminalId: terminal.id })).exited).toBeUndefined()

      await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'exit\n' })
      await waitUntil(
        async () => (await service.handlers['terminal.list']({})).some((t) => t.id === terminal.id && !t.running),
        'the shell to exit'
      )
      expect((await service.handlers['terminal.read']({ terminalId: terminal.id })).exited).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'names a pane, lets a rename beat the name it was created with, and clears it on request',
    async () => {
      const service = newService()
      // The composer's name, as `startTask` sends it.
      const terminal = await service.handlers['terminal.create']({
        worktreeId: WORKTREE,
        label: 'auth refactor'
      })
      expect(terminal.label).toBe('auth refactor')

      const renamed = await service.handlers['terminal.rename']({
        terminalId: terminal.id,
        label: 'auth refactor · take two'
      })
      expect(renamed.label).toBe('auth refactor · take two')
      expect((await service.handlers['terminal.list']({})).map((one) => one.label)).toEqual([
        'auth refactor · take two'
      ])

      // Null: back to being called whatever it is running.
      const cleared = await service.handlers['terminal.rename']({ terminalId: terminal.id, label: null })
      expect(cleared.label).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'resizes and reports the new size',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      const resized = await service.handlers['terminal.resize']({ terminalId: terminal.id, cols: 132, rows: 43 })
      expect(resized).toMatchObject({ id: terminal.id, cols: 132, rows: 43 })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'splits a pane and puts the new terminal beside it',
    async () => {
      const service = newService()
      const first = await newTerminal(service)
      const { terminal: second, layout } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'row'
      })

      expect(second.worktreeId).toBe(WORKTREE)
      expect(second.cwd).toBe(first.cwd)
      expect(layout.root).toEqual({
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', terminalId: first.id },
          { kind: 'leaf', terminalId: second.id }
        ]
      })
      expect(layout.focusedTerminalId).toBe(second.id)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'lands each new pane in the most room, so four make a 2x2 grid',
    async () => {
      const service = newService()
      const area = { width: 1000, height: 800 }
      const ids: string[] = []
      for (let i = 0; i < 4; i++) {
        const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE, area })
        ids.push(terminal.id)
      }
      const [a, b, c, d] = ids.map((terminalId) => ({ kind: 'leaf', terminalId }))
      expect((await service.handlers['layout.get']({ worktreeId: WORKTREE })).root).toEqual({
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [a, c] },
          { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [b, d] }
        ]
      })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'collapses the layout when a split pane is closed',
    async () => {
      const service = newService()
      const first = await newTerminal(service)
      const { terminal: second } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'column'
      })

      expect(await service.handlers['terminal.close']({ terminalId: second.id })).toEqual({ closed: true })

      const layout = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(layout.root).toEqual({ kind: 'leaf', terminalId: first.id })
      expect(layout.focusedTerminalId).toBe(first.id)
      expect(await service.handlers['terminal.list']({ worktreeId: WORKTREE })).toHaveLength(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'empties the layout when the last pane is closed',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      await service.handlers['terminal.close']({ terminalId: terminal.id })

      expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual({
        worktreeId: WORKTREE,
        root: null,
        focusedTerminalId: null
      })
      expect(await service.handlers['terminal.list']({})).toEqual([])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'streams data and exit to a subscriber, and stops on unsubscribe',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service, printThenExit('streamed', 3))
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })

      await waitUntil(
        () => published.some(({ event }) => event.type === 'exit'),
        'the exit event to reach the subscriber'
      )
      expect(published.every((entry) => entry.subscription === subscription)).toBe(true)
      const data = published
        .filter((entry) => entry.event.type === 'data')
        .map((entry) => (entry.event.type === 'data' ? entry.event.data : ''))
        .join('')
      expect(data).toContain('streamed')
      expect(published.at(-1)?.event).toEqual({ type: 'exit', exitCode: 3 })

      expect(service.unsubscribe(subscription)).toBe(true)
      expect(service.unsubscribe(subscription)).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'hands a subscription to the connection hub when one is configured',
    async () => {
      // Mirrors SubscriptionHub: it owns the id and the teardown.
      const emitted: TerminalEvent[] = []
      let teardown = (): void => {}
      let closedByProducer = false
      const hub = {
        subscribe(connectionId: string, source: (channel: StreamChannel) => () => void): string {
          expect(connectionId).toBe('conn-1')
          teardown = source({
            emit: (event) => emitted.push(event),
            close: () => {
              closedByProducer = true
              teardown()
            }
          })
          return 'hub_sub_1'
        }
      }

      const service = createTerminalService({
        subscriptions: hub,
        resolveWorktreeCwd: () => process.cwd()
      })
      services.push(service)

      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE })
      const result = await service.handlers['terminal.subscribe'](
        { terminalId: terminal.id },
        { connectionId: 'conn-1' }
      )
      expect(result).toEqual({ subscription: 'hub_sub_1' })

      await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'hubbub\n' })
      await waitUntil(
        () => emitted.some((event) => event.type === 'data' && event.data.includes('hubbub')),
        'the hub to receive data'
      )

      await service.handlers['terminal.close']({ terminalId: terminal.id })
      expect(closedByProducer).toBe(true)
      expect(published).toHaveLength(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'drops subscriptions when their terminal closes',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })

      await service.handlers['terminal.close']({ terminalId: terminal.id })
      expect(service.unsubscribe(subscription)).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reports a not_found for a terminal that is gone',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      await service.handlers['terminal.close']({ terminalId: terminal.id })

      const failure = await service.handlers['terminal.read']({ terminalId: terminal.id }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure)).toBe(true)
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.NotFound)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'refuses to create a terminal with no resolvable cwd',
    async () => {
      const service = newService()
      const failure = await service.handlers['terminal.create']({ worktreeId: 'wt_unknown' }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.InvalidParams)

      const missingCwd = await service.handlers['terminal.create']({
        worktreeId: WORKTREE,
        cwd: '/definitely/not/a/directory'
      }).catch((error: unknown) => error)
      expect(isTerminalServiceError(missingCwd) ? missingCwd.code : undefined).toBe(ErrorCode.NotFound)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'kills every process tree on shutdown',
    async () => {
      const service = newService()
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-process-tree-'))
      scratchDirs.push(scratch)
      const terminal = await newTerminal(service, await writeProcessTreeProbe(scratch))
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })
      expect(subscription).toMatch(/^sub_/)

      let grandchild = 0
      await waitUntil(() => {
        const text = published.map((entry) => (entry.event.type === 'data' ? entry.event.data : '')).join('')
        grandchild = Number(/child:(\d+)/.exec(text)?.[1] ?? 0)
        return grandchild > 0
      }, 'the grandchild pid')
      expect(isProcessAlive(grandchild)).toBe(true)

      await service.shutdown()

      await waitUntil(() => !isProcessAlive(grandchild), 'the grandchild to be reaped')
      expect(await service.handlers['terminal.list']({})).toEqual([])
    },
    TEST_TIMEOUT_MS
  )
})

/** That program, in that directory, again — without the pane moving. */
describePty('running an exited pane again', () => {
  /** A service whose records are readable, which is where a session id lives. */
  function serviceWithRecords(): { service: TerminalService; records: Map<string, TerminalRecord> } {
    const records = new Map<string, TerminalRecord>()
    const service = createTerminalService({
      publish: (subscription, event) => published.push({ subscription, event }),
      resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? process.cwd() : undefined),
      sessions: {
        listTerminals: () => [...records.values()],
        putTerminal: (record) => {
          records.set(record.id, record)
          return record
        },
        removeTerminal: (terminalId) => records.delete(terminalId)
      }
    })
    services.push(service)
    return { service, records }
  }

  async function scratchDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'teamree-relaunch-'))
    scratchDirs.push(directory)
    return directory
  }

  const hasExited = async (service: TerminalService, terminalId: string): Promise<boolean> => {
    const list = await service.handlers['terminal.list']({})
    return list.some((terminal) => terminal.id === terminalId && !terminal.running)
  }

  it(
    'refuses a pane that has not exited, and says why',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      const failure = await service.handlers['terminal.relaunch']({ terminalId: terminal.id }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.Conflict)
      expect(isTerminalServiceError(failure) ? failure.message : '').toContain('has not exited')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts the same agent over, in the same pane, under a session id of its own',
    async () => {
      const { service, records } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE, command })
      expect(terminal.agent).toBe('claude')

      await waitUntil(() => hasExited(service, terminal.id), 'the agent pane to exit')
      const first = records.get(terminal.id)?.agentSessionId
      expect(first).toBeDefined()
      const before = await service.handlers['terminal.read']({ terminalId: terminal.id })
      expect(before.data).toContain(first)

      const again = await service.handlers['terminal.relaunch']({ terminalId: terminal.id })

      // The same pane: a different id would be a different leaf.
      expect(again.id).toBe(terminal.id)
      expect(again.cwd).toBe(terminal.cwd)
      expect(again.agent).toBe('claude')
      expect(again.running).toBe(true)
      // Not the conversation that ended.
      const second = records.get(terminal.id)?.agentSessionId
      expect(second).toBeDefined()
      expect(second).not.toBe(first)
      expect(records.get(terminal.id)?.typed).toBe(false)

      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: terminal.id })
        return data.includes(second as string)
      }, 'the second run to say which session it was given')

      // What the dead pane printed is still there, above the line.
      const after = (await service.handlers['terminal.read']({ terminalId: terminal.id })).data
      const banner = after.indexOf('claude starts again below')
      expect(banner).toBeGreaterThan(-1)
      expect(after.indexOf(first as string)).toBeLessThan(banner)
      expect(after.indexOf(second as string)).toBeGreaterThan(banner)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps the name the pane was given, because running the program again is not taking it back',
    async () => {
      const { service, records } = serviceWithRecords()
      const terminal = await service.handlers['terminal.create']({
        worktreeId: WORKTREE,
        command: printThenExit('one-shot', 0),
        label: 'auth refactor'
      })
      await waitUntil(() => hasExited(service, terminal.id), 'the command pane to exit')

      const again = await service.handlers['terminal.relaunch']({ terminalId: terminal.id })
      // On the pane and on the record.
      expect(again.label).toBe('auth refactor')
      expect(records.get(terminal.id)?.label).toBe('auth refactor')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'brings a pane that was not running an agent back as a shell, not as its command again',
    async () => {
      const { service, records } = serviceWithRecords()
      const terminal = await newTerminal(service, printThenExit('one-shot', 4))
      await waitUntil(() => hasExited(service, terminal.id), 'the command pane to exit')

      const again = await service.handlers['terminal.relaunch']({ terminalId: terminal.id })
      expect(again.id).toBe(terminal.id)
      expect(again.ordinal).toBe(terminal.ordinal)
      expect(again.agent).toBeUndefined()
      // The same refusal `restoreLaunch` makes: nobody asked for it twice.
      expect(records.get(terminal.id)?.command).toBeUndefined()

      const after = (await service.handlers['terminal.read']({ terminalId: terminal.id })).data
      expect(after).toContain('new shell below')
      expect(after.indexOf('one-shot')).toBeLessThan(after.indexOf('new shell below'))
    },
    TEST_TIMEOUT_MS
  )

  it(
    'leaves the split tree exactly where it was',
    async () => {
      const { service } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const first = await service.handlers['terminal.create']({ worktreeId: WORKTREE })
      const { terminal: second } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'row',
        command
      })

      await waitUntil(() => hasExited(service, second.id), 'the split pane to exit')
      const before = await service.handlers['layout.get']({ worktreeId: WORKTREE })

      await service.handlers['terminal.relaunch']({ terminalId: second.id })

      expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(before)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps a subscription open across the relaunch, and says in it where the new run starts',
    async () => {
      const { service } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE, command })
      await service.handlers['terminal.subscribe']({ terminalId: terminal.id })
      await waitUntil(() => hasExited(service, terminal.id), 'the agent pane to exit')

      published.length = 0
      await service.handlers['terminal.relaunch']({ terminalId: terminal.id })

      // A subscription is to the pane, not to the process.
      await waitUntil(
        () =>
          published.some(({ event }) => event.type === 'data' && event.data.includes('claude starts again below')) &&
          published.some(({ event }) => event.type === 'data' && event.data.includes('agent args:')),
        'the banner and the second run to reach the subscriber'
      )
    },
    TEST_TIMEOUT_MS
  )
})

describe('layout handlers', () => {
  it('stores a tree wholesale and normalises its sizes', async () => {
    const service = createTerminalService()
    const stored = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [3, 1],
        children: [
          { kind: 'leaf', terminalId: 'a' },
          { kind: 'leaf', terminalId: 'b' }
        ]
      },
      focusedTerminalId: 'b'
    })

    expect(stored.root).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.75, 0.25],
      children: [
        { kind: 'leaf', terminalId: 'a' },
        { kind: 'leaf', terminalId: 'b' }
      ]
    })
    expect(stored.focusedTerminalId).toBe('b')
    expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(stored)
  })

  it('clears focus that names a pane the tree does not have', async () => {
    const service = createTerminalService()
    const stored = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'ghost'
    })
    expect(stored.focusedTerminalId).toBeNull()
  })

  it('accepts an empty layout', async () => {
    const service = createTerminalService()
    expect(await service.handlers['layout.set']({ worktreeId: WORKTREE, root: null, focusedTerminalId: null })).toEqual(
      {
        worktreeId: WORKTREE,
        root: null,
        focusedTerminalId: null
      }
    )
  })

  it('rejects a tree that is not a tree', async () => {
    const service = createTerminalService()
    const failure = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf' },
      focusedTerminalId: null
    }).catch((error: unknown) => error)
    expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.InvalidParams)
  })

  it('hands the stored tree out as a copy', async () => {
    const service = createTerminalService()
    const first = await service.handlers['layout.get']({ worktreeId: WORKTREE })
    await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
    expect(first.root).toBeNull()

    const stored = await service.handlers['layout.get']({ worktreeId: WORKTREE })
    if (stored.root?.kind === 'leaf') stored.root.terminalId = 'tampered'
    expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
  })
})

describe('layout persistence', () => {
  it('reads and writes through an external repository', async () => {
    // The workspace store already has this shape.
    const saved = new Map<string, Layout>()
    const service = createTerminalService({
      layouts: {
        getLayout: (worktreeId) => saved.get(worktreeId),
        putLayout: (layout) => {
          saved.set(layout.worktreeId, layout)
          return layout
        }
      }
    })

    await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
    expect(saved.get(WORKTREE)).toEqual({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })

    const restored = createTerminalService({
      layouts: { getLayout: (id) => saved.get(id), putLayout: (layout) => layout }
    })
    expect(await restored.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(saved.get(WORKTREE))
  })
})

describe('registerTerminalHandlers', () => {
  it('registers every terminal and layout method with its schema', () => {
    const service = createTerminalService()
    const registered = new Map<string, unknown>()
    const registry: MethodRegistry = {
      register: (method, schema) => {
        registered.set(method, schema)
      }
    }

    registerTerminalHandlers(registry, service)

    expect([...registered.keys()].sort()).toEqual([
      'agent.list',
      'layout.get',
      'layout.set',
      'terminal.agentEvent',
      'terminal.close',
      'terminal.closed',
      'terminal.create',
      'terminal.list',
      'terminal.read',
      'terminal.relaunch',
      'terminal.rename',
      'terminal.reopen',
      'terminal.resize',
      'terminal.split',
      'terminal.subagentEvent',
      'terminal.subagentTranscript',
      'terminal.subscribe',
      'terminal.write'
    ])
    // The schemas come from the contract.
    expect(registered.get('terminal.create')).toBe(service.schemas['terminal.create'])
  })
})

// One field, the latest thing said, overtaken only by a keystroke when it was
// about a turn in progress; a turn that ended stays ended.
describePty('terminal.agentEvent', () => {
  it(
    'records the latest event on the pane and answers with the pane',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      const said = await service.handlers['terminal.agentEvent']({
        terminalId: terminal.id,
        event: 'Notification',
        at: 5_000,
        detail: 'permission_prompt',
        message: 'Claude needs your permission to use Edit'
      })
      expect(said.agentEvent).toEqual({
        event: 'Notification',
        at: 5_000,
        detail: 'permission_prompt',
        message: 'Claude needs your permission to use Edit'
      })
      expect((await service.handlers['terminal.list']({}))[0]?.agentEvent).toEqual(said.agentEvent)

      const later = await service.handlers['terminal.agentEvent']({ terminalId: terminal.id, event: 'Stop', at: 6_000 })
      expect(later.agentEvent).toEqual({ event: 'Stop', at: 6_000 })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'lets a keystroke overtake a request or a running turn, but not a turn that ended',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      const said = async (event: 'Notification' | 'UserPromptSubmit' | 'Stop'): Promise<void> => {
        await service.handlers['terminal.agentEvent']({ terminalId: terminal.id, event, at: 1 })
      }
      const current = async (): Promise<string | undefined> =>
        (await service.handlers['terminal.list']({}))[0]?.agentEvent?.event

      await said('Notification')
      await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'y' })
      expect(await current()).toBeUndefined()

      await said('UserPromptSubmit')
      await service.handlers['terminal.write']({ terminalId: terminal.id, data: '\x1b' })
      expect(await current()).toBeUndefined()

      await said('Stop')
      await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'next prompt' })
      expect(await current()).toBe('Stop')

      // The emulator answering the program's own questions is nobody typing.
      await said('Notification')
      await service.handlers['terminal.write']({ terminalId: terminal.id, data: '\x1b[?1;2c', byHand: false })
      expect(await current()).toBe('Notification')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'refuses a pane that does not exist',
    async () => {
      const service = newService()
      await expect(
        service.handlers['terminal.agentEvent']({ terminalId: 'term_nope', event: 'Stop', at: 1 })
      ).rejects.toSatisfy((error: unknown) => isTerminalServiceError(error) && error.code === ErrorCode.NotFound)
    },
    TEST_TIMEOUT_MS
  )
})

describe('splitting beside a file pane', () => {
  it('opens the new shell in the worktree and puts it beside the file leaf', async () => {
    const file = { kind: 'leaf' as const, terminalId: 'file:1', pane: 'file' as const, path: 'NOTES.md' }
    const layouts = new Map<string, Layout>([['w1', { worktreeId: 'w1', root: file, focusedTerminalId: 'file:1' }]])
    const manager = new TerminalSessionManager({
      layouts: {
        getLayout: (id) => layouts.get(id),
        putLayout: (layout) => {
          layouts.set(layout.worktreeId, layout)
          return layout
        },
        listLayouts: () => [...layouts.values()]
      },
      resolveWorktreeCwd: () => process.cwd()
    })
    try {
      const { terminal, layout } = manager.split({ terminalId: 'file:1', direction: 'column' })
      expect(terminal.worktreeId).toBe('w1')
      expect(layout.root).toEqual({
        kind: 'split',
        direction: 'column',
        sizes: [0.5, 0.5],
        children: [file, { kind: 'leaf', terminalId: terminal.id }]
      })
      expect(() => manager.split({ terminalId: 'file:nowhere', direction: 'row' })).toThrow(/no such terminal/)
    } finally {
      await manager.shutdown()
    }
  })
})
