// A worktree row dragged onto another row or a project header, and the moves it and the row menu ask
// for: a dry run first, a question before a rebase, and a notice for how it went.

import { create } from 'zustand'
import type { WorktreeNest } from '@shared/nesting'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import {
  dropZone,
  nestAction,
  nestDropTarget,
  nestedText,
  spotKey,
  type DropTarget,
  type NestProbe,
  type NestSpot
} from './nestDrop'

/** The drag's type, so a drop elsewhere (a folder, a file) is never taken for a row. */
export const NEST_DRAG_TYPE = 'application/x-teamree-worktree'

type NestDragState = {
  dragging: string | null
  over: string | null
  /** Dry runs answered during this drag, keyed by `probeKey`. */
  probes: Record<string, NestProbe>
}

export const useNestDrag = create<NestDragState>(() => ({ dragging: null, over: null, probes: {} }))

const probeKey = (worktreeId: string, key: string): string => `${worktreeId}>${key}`
const asked = new Set<string>()

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const parentOf = (spot: NestSpot): string | null => ('parentId' in spot ? spot.parentId : null)

function hover(spot: NestSpot | null): void {
  const { dragging, over } = useNestDrag.getState()
  const key = spot === null ? null : spotKey(spot)
  if (key !== over) useNestDrag.setState({ over: key })
  if (dragging === null || spot === null || key === null) return
  const probe = probeKey(dragging, key)
  if (asked.has(probe) || nestDropTarget(useWorkspaceStore.getState().worktrees, dragging, spot)?.allowed !== true) {
    return
  }
  asked.add(probe)
  runtimeClient
    .call('worktree.nest', { worktreeId: dragging, parentId: parentOf(spot), dryRun: true })
    .then(
      (plan): NestProbe => ({
        change: plan.change,
        ...(plan.inherited === undefined ? {} : { inherited: plan.inherited })
      }),
      (error: unknown): NestProbe => ({ reason: message(error) })
    )
    .then((answer) => {
      if (useNestDrag.getState().dragging !== dragging) return
      useNestDrag.setState((state) => ({ probes: { ...state.probes, [probe]: answer } }))
    })
}

export function startNestDrag(worktreeId: string): void {
  asked.clear()
  useNestDrag.setState({ dragging: worktreeId, over: null, probes: {} })
}

export function endNestDrag(): void {
  asked.clear()
  useNestDrag.setState({ dragging: null, over: null, probes: {} })
}

type DropHandlers = Pick<React.DOMAttributes<HTMLElement>, 'onDragOver' | 'onDragEnter' | 'onDragLeave' | 'onDrop'>

/** A drop target's state while a row is over it, and the handlers that make it one. `edges`: its edges are between rows. */
export function useNestDrop(spot: NestSpot, edges: boolean): { target: DropTarget | null; handlers: DropHandlers } {
  const key = spotKey(spot)
  const dragging = useNestDrag((state) => state.dragging)
  const over = useNestDrag((state) => state.over === key)
  const probe = useNestDrag((state) =>
    state.dragging === null ? undefined : state.probes[probeKey(state.dragging, key)]
  )
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const target = dragging !== null && over ? nestDropTarget(worktrees, dragging, spot, probe) : null

  const onto = (event: React.DragEvent<HTMLElement>): boolean => {
    if (!edges) return true
    const rect = event.currentTarget.getBoundingClientRect()
    return dropZone(event.clientY - rect.top, rect.height) === 'onto'
  }
  /** The target under the pointer now, read fresh: the drag's events come faster than renders. */
  const targetAt = (event: React.DragEvent<HTMLElement>, moving: string): DropTarget | null => {
    if (!onto(event)) return null
    const probes = useNestDrag.getState().probes
    return nestDropTarget(useWorkspaceStore.getState().worktrees, moving, spot, probes[probeKey(moving, key)])
  }
  const track = (event: React.DragEvent<HTMLElement>): void => {
    const moving = useNestDrag.getState().dragging
    if (moving === null) return
    const now = targetAt(event, moving)
    hover(onto(event) ? spot : null)
    if (now?.allowed !== true) return
    // Only an allowed target takes the drop; anything else keeps the no-drop cursor.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  return {
    target,
    handlers: {
      onDragEnter: track,
      onDragOver: track,
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (useNestDrag.getState().over === key) useNestDrag.setState({ over: null })
      },
      onDrop: (event) => {
        const moving = useNestDrag.getState().dragging
        if (moving === null) return
        event.preventDefault()
        const allowed = targetAt(event, moving)?.allowed === true
        endNestDrag()
        if (allowed) void moveWorktree(moving, parentOf(spot))
      }
    }
  }
}

/** Moves a worktree under `parentId`, or to the top level with null: dry run, then a question before a rebase. */
export async function moveWorktree(worktreeId: string, parentId: string | null): Promise<void> {
  let plan: WorktreeNest
  try {
    plan = await runtimeClient.call('worktree.nest', { worktreeId, parentId, dryRun: true })
  } catch (error) {
    refused(worktreeId, error)
    return
  }
  const action = nestAction(plan)
  if (action === 'none') return
  if (action === 'confirm' && parentId !== null) {
    useWorkspaceStore.getState().openDialog({ kind: 'confirm-rebase', worktreeId, parentId })
    return
  }
  await applyNest(worktreeId, parentId, false)
}

/** The move itself; `rebase` once the question has been answered. */
export async function applyNest(worktreeId: string, parentId: string | null, rebase: boolean): Promise<void> {
  const before = useWorkspaceStore.getState().worktrees
  let result: WorktreeNest
  try {
    result = await runtimeClient.call('worktree.nest', { worktreeId, parentId, ...(rebase ? { rebase: true } : {}) })
  } catch (error) {
    refused(worktreeId, error)
    return
  }
  useWorkspaceStore.setState((state) => ({
    worktrees: state.worktrees.map((entry) => (entry.id === result.worktree.id ? result.worktree : entry))
  }))
  useWorkspaceStore.getState().showNotice(nestedText(before, result), 'info')
}

function refused(worktreeId: string, error: unknown): void {
  const name = useWorkspaceStore.getState().worktrees.find((entry) => entry.id === worktreeId)?.name ?? 'worktree'
  useWorkspaceStore.getState().showNotice(`Could not move ${name}: ${message(error)}`, 'error')
}
