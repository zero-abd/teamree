// Tokens per worktree as last read, and whether Show Cost is on. Read while a surface shows them:
// the board and the Changes tab on a timer, a sidebar row when hovered.

import { useEffect } from 'react'
import { create } from 'zustand'
import type { WorktreeUsage } from '@shared/tasks'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

/** How often a surface that shows tokens reads them again. */
export const USAGE_EVERY_MS = 30_000

/** A hovered row is not read again sooner than this. */
const HOVER_FRESH_MS = 10_000

export type UsageQuery = { worktreeId?: string; projectId?: string }

type UsageState = {
  usage: Readonly<Record<string, WorktreeUsage>>
  showCost: boolean
  read: (query: UsageQuery) => Promise<void>
  /** A read for one row's hover, skipped when that row was read a moment ago. */
  hover: (worktreeId: string) => void
}

export const useUsageStore = create<UsageState>((set, get) => ({
  usage: {},
  showCost: false,
  read: async (query) => {
    const [read, settings] = await Promise.all([
      runtimeClient.call('worktree.usage', query),
      runtimeClient.call('settings.get', {}).catch(() => null)
    ])
    set((state) => ({
      usage: { ...state.usage, ...Object.fromEntries(read.map((each) => [each.worktreeId, each])) },
      showCost: settings?.showCost ?? state.showCost
    }))
  },
  hover: (worktreeId) => {
    const held = get().usage[worktreeId]
    if (held !== undefined && Date.now() - held.readAt < HOVER_FRESH_MS) return
    void get()
      .read({ worktreeId })
      .catch(() => {})
  }
}))

/** Reads `query` now and every `USAGE_EVERY_MS` while it is not null. */
export function useUsageReads(query: UsageQuery | null): void {
  const key = query === null ? null : JSON.stringify(query)
  useEffect(() => {
    if (key === null) return
    const asked = JSON.parse(key) as UsageQuery
    const read = (): void =>
      void useUsageStore
        .getState()
        .read(asked)
        .catch(() => {})
    read()
    const timer = setInterval(read, USAGE_EVERY_MS)
    return () => clearInterval(timer)
  }, [key])
}
