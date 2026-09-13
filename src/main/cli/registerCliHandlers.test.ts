// Proof that the seam fits: the real registry and dispatcher, driven with
// wire-shaped requests. The service underneath is pointed at a temporary
// directory, so this exercises the whole path without going near
// /usr/local/bin.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliInstall, CliStatus } from '../../shared/entities'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { WorkspaceStore } from '../store/workspaceStore'
import { CliService } from './cliService'
import { registerCliHandlers } from './handlers'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function wire(): Promise<{
  call: (method: string, params?: unknown) => Promise<unknown>
  destination: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamree-cli-seam-'))
  dirs.push(root)
  const source = path.join(root, 'app', 'Contents', 'Resources', 'cli', 'teamree')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '#!/bin/sh\n', { mode: 0o755 })
  const directory = path.join(root, 'bin')
  await mkdir(directory)

  const store = await WorkspaceStore.open(path.join(root, 'workspace.json'))
  const registry = new MethodRegistry(
    createRuntimeContext({ version: '0.0.0-test', store, subscriptions: new SubscriptionHub() })
  )
  registerCliHandlers(
    registry,
    new CliService({ source, directory, platform: 'darwin', env: { PATH: directory }, writable: async () => true })
  )

  const dispatch = createDispatcher(registry)
  let counter = 0
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    counter += 1
    const response = await dispatch({ id: `r${counter}`, method, params }, { connectionId: 'test' })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
  return { call, destination: path.join(directory, 'teamree') }
}

describe('registerCliHandlers', () => {
  it('answers both methods through the runtime dispatcher', async () => {
    const { call, destination } = await wire()

    const before = (await call('cli.status', {})) as CliStatus
    expect(before.state).toBe('absent')
    expect(before.destination).toBe(destination)

    const installed = (await call('cli.install', {})) as CliInstall
    expect(installed.outcome).toBe('linked')

    const after = (await call('cli.status', {})) as CliStatus
    expect(after.state).toBe('linked')

    // Twice, because idempotence is a promise made to whoever presses the
    // button again rather than an implementation detail.
    expect(((await call('cli.install', {})) as CliInstall).outcome).toBe('already-linked')
  })

  it('keeps the refusal’s error code on the wire instead of collapsing to internal', async () => {
    const { call, destination } = await wire()
    await writeFile(destination, 'somebody else’s binary')

    await expect(call('cli.install', {})).rejects.toThrow(/^conflict:/)
  })
})
