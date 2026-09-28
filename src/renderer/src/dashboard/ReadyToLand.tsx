// The board's Ready to land: each finished task with work, with Review, Land and Discard, and Land All,
// which asks first, skips one that fails and lands the rest, and pushes each project once at the end.

import { useMemo, useState } from 'react'
import { ConfirmLandAllDialog } from '../dialogs/ConfirmLandAllDialog'
import { useReviewStore } from '../review/reviewStore'
import { openInBrowser } from '../shell/openInBrowser'
import { useOverlaps } from '../state/overlapStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { heldBack, readyToMerge, type ChildRow } from '../workspace/rightPanel/childrenModel'
import { ChildFacts, LandStops } from '../workspace/rightPanel/ChildrenSection'
import { LANDING_QUEUE, useChildren } from '../workspace/rightPanel/childrenStore'
import { landLabel, landOffer, type LandOffer } from '../workspace/rightPanel/landOffer'
import { landingQueue } from './landingQueue'

export function ReadyToLand(): React.JSX.Element | null {
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const landings = useWorkspaceStore((state) => state.landings)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const createPullRequest = useWorkspaceStore((state) => state.createPullRequest)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const overlaps = useOverlaps((state) => state.byProject)
  const merging = useChildren((state) => state.merging[LANDING_QUEUE])
  const [asking, setAsking] = useState(false)
  const rows = useMemo(
    () =>
      landingQueue({
        projects,
        worktrees,
        terminals: Object.values(terminals),
        statuses,
        mergePreviews,
        landings,
        overlaps: Object.values(overlaps).flat(),
        now: Date.now()
      }),
    [projects, worktrees, terminals, statuses, mergePreviews, landings, overlaps]
  )
  if (rows.length === 0) return null

  const offerOf = (row: ChildRow): LandOffer | null => landOffer(landings[row.worktreeId], statuses[row.worktreeId])
  // A pull request lands on the host, in its own time; Land All runs the merges made here.
  const merges = rows.filter((row) => offerOf(row)?.kind === 'merge')
  const ready = readyToMerge(merges)
  const held = heldBack(merges)
  const busy = merging !== undefined
  const land = (row: ChildRow): void => {
    const offer = offerOf(row)
    if (offer?.kind === 'open-pr') openInBrowser(offer.url)
    else if (offer?.kind === 'create-pr') void createPullRequest(row.worktreeId)
    else openDialog({ kind: 'confirm-merge', worktreeId: row.worktreeId })
  }
  const review = async (worktreeId: string): Promise<void> => {
    await openWorktree(worktreeId)
    useReviewStore.getState().reviewBranch(worktreeId)
  }

  return (
    <Card
      className="landq"
      title={
        <>
          Ready to land <span className="panel__count">{rows.length}</span>
        </>
      }
      actions={
        <Button
          size="sm"
          variant="primary"
          className="landq__all"
          disabled={busy || ready.length === 0}
          title={ready.map((row) => row.title).join('\n') || undefined}
          onClick={() => setAsking(true)}
        >
          Land All
        </Button>
      }
    >
      {asking ? (
        <ConfirmLandAllDialog
          rows={merges.filter((row) => ready.includes(row) || held.some((each) => each.worktreeId === row.worktreeId))}
          held={held}
          onClose={() => setAsking(false)}
        />
      ) : null}
      <LandStops runKey={LANDING_QUEUE} rows={rows} />
      <ul className="landq__list">
        {rows.map((row) => {
          const landing = landings[row.worktreeId]
          const offer = offerOf(row)
          return (
            <li key={row.worktreeId} className="landq__row" aria-label={row.title}>
              <button
                type="button"
                className="landq__name"
                title={row.title}
                onClick={() => void openWorktree(row.worktreeId)}
              >
                {row.title}
              </button>
              <span className="child__facts">
                <ChildFacts row={row} into={landing?.parent?.name ?? landing?.base ?? ''} />
              </span>
              <span className="landq__actions">
                <Button size="sm" variant="ghost" onClick={() => void review(row.worktreeId)}>
                  Review
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  title={offer === null || offer.kind === 'merged' ? undefined : landLabel(offer)}
                  onClick={() => land(row)}
                >
                  {merging === row.worktreeId ? 'Landing…' : 'Land'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void removeWorktree(row.worktreeId)}>
                  Discard
                </Button>
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
