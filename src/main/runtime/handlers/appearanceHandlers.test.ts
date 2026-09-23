import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Appearance } from '../../../shared/theme'
import { WorkspaceStore } from '../../store/workspaceStore'
import { createDispatcher } from '../dispatcher'
import { MethodRegistry } from '../methodRegistry'
import { createRuntimeContext } from '../runtimeContext'
import { SubscriptionHub } from '../subscriptionHub'
import { registerAppearanceHandlers } from './appearanceHandlers'

const call = { connectionId: 'test' }
const CHOICE = { themeId: 'black', ground: null, accent: null, overrides: {} }

describe('appearance.set', () => {
  let directory: string
  let registry: MethodRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-appearance-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    registry = new MethodRegistry(
      createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps the mode and the light slot, and tells the app what it stored', async () => {
    const told: Appearance[] = []
    registerAppearanceHandlers(registry, (appearance) => told.push(appearance))
    const params = { ...CHOICE, mode: 'light', light: { ...CHOICE, themeId: 'paper' } }

    const response = await createDispatcher(registry)({ id: 'a1', method: 'appearance.set', params }, call)

    expect(response).toMatchObject({ ok: true, result: { mode: 'light', light: { themeId: 'paper' } } })
    expect(told).toEqual([registry.context.store.getAppearance()])
    expect(told[0]?.mode).toBe('light')
  })

  it('refuses a mode it does not know', async () => {
    registerAppearanceHandlers(registry)
    const response = await createDispatcher(registry)(
      { id: 'a2', method: 'appearance.set', params: { ...CHOICE, mode: 'sepia' } },
      call
    )
    expect(response).toMatchObject({ ok: false })
  })
})
