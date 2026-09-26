import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ErrorCode, type ErrorResponse } from '../../shared/protocol'
import { WorkspaceStore } from '../store/workspaceStore'
import { registerPlaceholderHandlers } from './handlers/placeholderHandlers'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { registerHandlers } from './handlers/registerHandlers'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { RuntimeError } from './runtimeError'
import { SubscriptionHub } from './subscriptionHub'

const call = { connectionId: 'test' }

describe('dispatcher', () => {
  let directory: string
  let registry: MethodRegistry
  let dispatch: Dispatcher
  let context: ReturnType<typeof createRuntimeContext>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-dispatch-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    context = createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    context.endpoint = '/tmp/teamree-test.sock'
    registry = new MethodRegistry(context)
    registerHandlers(registry)
    dispatch = createDispatcher(registry)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('answers status.get with the runtime identity', async () => {
    const response = await dispatch({ id: 'a1', method: 'status.get', params: {} }, call)

    expect(response).toMatchObject({
      id: 'a1',
      ok: true,
      result: { version: '9.9.9', endpoint: '/tmp/teamree-test.sock', pid: process.pid, platform: process.platform }
    })
  })

  // The wiring: a runtime with no way to quit must refuse `app.quit`, never
  // answer unknown_method — which would read as a CLI too new for this app.
  it('offers app.quit, and refuses it when there is no app behind the runtime', async () => {
    const response = (await dispatch({ id: 'a3', method: 'app.quit', params: {} }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.NotFound)
    expect(response.error.message).toMatch(/no app to quit/)
  })

  it('treats absent params as an empty object', async () => {
    const response = await dispatch({ id: 'a2', method: 'status.get' }, call)
    expect(response.ok).toBe(true)
  })

  it('rejects an unknown method', async () => {
    const response = (await dispatch({ id: 'b1', method: 'nope.nope', params: {} }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.UnknownMethod)
    expect(response.error.message).toContain('nope.nope')
  })

  it('rejects invalid params and reports the offending path', async () => {
    const response = (await dispatch({ id: 'c1', method: 'worktree.get', params: {} }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.InvalidParams)
    expect(response.error.data).toMatchObject([{ path: 'worktreeId' }])
  })

  it('rejects a malformed envelope', async () => {
    const response = (await dispatch({ method: 'status.get' }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.BadRequest)
    expect(response.id).toBe('')
  })

  it('maps an unexpected handler throw to internal', async () => {
    registry.register('project.list', z.object({}), () => {
      throw new Error('disk on fire')
    })

    const response = (await dispatch({ id: 'd1', method: 'project.list', params: {} }, call)) as ErrorResponse

    expect(response.error.code).toBe(ErrorCode.Internal)
    expect(response.error.message).toBe('disk on fire')
  })

  it('preserves the code and data of a RuntimeError', async () => {
    registry.register('project.list', z.object({}), () => {
      throw new RuntimeError(ErrorCode.GitFailed, 'fetch failed', { exitCode: 128 })
    })

    const response = (await dispatch({ id: 'd2', method: 'project.list', params: {} }, call)) as ErrorResponse

    expect(response.error).toEqual({ code: ErrorCode.GitFailed, message: 'fetch failed', data: { exitCode: 128 } })
  })

  it('reports a method left as a placeholder as not_found', async () => {
    // Every contract method has a real handler, so this uses a registry left unwired.
    const bare = new MethodRegistry(context)
    registerPlaceholderHandlers(bare)
    const response = (await createDispatcher(bare)(
      { id: 'e1', method: 'worktree.list', params: {} },
      call
    )) as ErrorResponse

    expect(response.error.code).toBe(ErrorCode.NotFound)
    expect(response.error.message).toContain('not implemented')
  })

  it('registers every method in the contract', () => {
    // Named rather than counted, so the diff says which method arrived or went.
    expect([...registry.methods()].sort()).toEqual([
      // Local: a switch that turns on a process on this machine.
      'addons.install',
      'addons.status',
      'agent.list',
      // Local: what this machine's agent CLIs trust.
      'agents.setTrust',
      'agents.trust',
      // Local: a teammate does not get to close the machine.
      'app.quit',
      // Local: a theme is a fact about one person's screen.
      'appearance.get',
      'appearance.set',
      // Local: no symlink into /usr/local/bin or password dialog for a teammate.
      'cli.dismissPrompt',
      'cli.install',
      'cli.status',
      // Local: starts a program on this machine.
      'editor.list',
      'editor.open',
      'file.read',
      'file.write',
      'layout.get',
      'layout.set',
      'members.join',
      'members.list',
      // Local: project memory stays on this machine; teammates see team notes only in presence.
      'memory.conflicts',
      'memory.forget',
      'memory.note',
      'memory.resolve',
      // Local: agent mail never crosses to a teammate.
      'message.list',
      'message.read',
      'message.send',
      // Reachable over the peer transport and nowhere else; in the one registry
      // because a teammate is another transport onto the catalogue. See `PEER_METHODS`.
      'peer.presence',
      'peer.subscribe',
      'project.add',
      // Local: git on this machine, with this machine's credentials.
      'project.cancelClone',
      'project.clone',
      'project.cloneProgress',
      'project.context',
      'project.list',
      'project.remove',
      // Local: writes into this machine's checkout.
      'project.saveSettings',
      'project.saveTemplate',
      // Local: what this machine's checkouts carry over is nobody else's setting.
      'project.setPaths',
      // Local: moves this machine's folder to its Trash.
      'project.templates',
      'project.trash',
      'project.trashPreview',
      // Local: switches for this machine.
      'settings.get',
      'settings.set',
      'status.get',
      // Local: this machine's processes are its own to read and signal. The kill is
      // guarded by a fresh sample too, so it reaches nothing but what a pane started.
      'system.kill',
      'system.resources',
      // Local for the reason the push is.
      'teamwork.cancelPublish',
      // Local and the owner's own; the write log never leaves this machine.
      'teamwork.decide',
      // Local: a handoff crosses in this machine's presence, never as a teammate's call.
      'teamwork.dismissHandoff',
      'teamwork.handOff',
      'teamwork.handoffs',
      'teamwork.mute',
      'teamwork.presence',
      // Local: these write to the repository this machine owns, and the peer
      // allow-list admits none of them. `publishProgress` only reads.
      'teamwork.publish',
      'teamwork.publishPlan',
      'teamwork.publishProgress',
      'teamwork.relay',
      'teamwork.requests',
      'teamwork.revoke',
      'teamwork.setOrigin',
      'teamwork.setRelay',
      'teamwork.status',
      'teamwork.take',
      // Local: this machine asking to read and type into somebody else's pane; on
      // the wire they are `terminal.subscribe`, `terminal.read` and `terminal.write`.
      'teamwork.type',
      'teamwork.watch',
      'teamwork.watchers',
      'teamwork.writeLog',
      // Local: the agent in a pane reporting on itself through the CLI socket.
      'terminal.agentEvent',
      'terminal.close',
      'terminal.closed',
      'terminal.create',
      'terminal.list',
      'terminal.read',
      // Local: a relaunch starts a process on this machine.
      'terminal.relaunch',
      'terminal.rename',
      // Local: starts a process on this machine, as a relaunch does.
      'terminal.reopen',
      'terminal.resize',
      'terminal.split',
      'terminal.subscribe',
      'terminal.write',
      'unsubscribe',
      // Local: no asking GitHub, changing a preference or opening a browser page for a teammate.
      'update.check',
      'update.download',
      'update.fetchInstaller',
      'update.openInstaller',
      'update.restart',
      'update.setAutomatic',
      'update.state',
      'workspace.subscribe',
      // Local: rewrites this machine's branch, as a commit does.
      'worktree.abortUpdate',
      'worktree.branches',
      'worktree.changes',
      'worktree.commit',
      'worktree.compare',
      'worktree.create',
      'worktree.createPullRequest',
      'worktree.diff',
      // Local: throws work away on this machine's disk.
      'worktree.discardHunk',
      'worktree.discardPath',
      // Local: a directory listing of this machine's checkout is its own to show.
      'worktree.files',
      'worktree.findFiles',
      'worktree.forget',
      'worktree.get',
      'worktree.keep',
      'worktree.landing',
      'worktree.list',
      'worktree.log',
      'worktree.mergeIntoBase',
      'worktree.mergePreview',
      'worktree.overlaps',
      // Local: runs this machine's gh, with its credentials.
      'worktree.pullRequests',
      'worktree.push',
      'worktree.remove',
      'worktree.removed',
      'worktree.rename',
      // Local: checks a copy out on this machine's disk.
      'worktree.restore',
      // Local: approves and runs a command on this machine.
      'worktree.setup',
      'worktree.showCommit',
      'worktree.stageHunk',
      'worktree.startPoints',
      'worktree.status',
      'worktree.undoDiscard',
      'worktree.unstageHunk',
      'worktree.unstagePath',
      'worktree.update',
      // Local: reads this machine's agent transcripts.
      'worktree.usage'
    ])
  })
})
