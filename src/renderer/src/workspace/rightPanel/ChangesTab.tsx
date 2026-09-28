// What this worktree has changed, as a source-control view in the right panel: the branch and its next step,
// the commit box, then Staged, Changes and what the branch already committed. A row opens its diff in the centre.

import { useEffect, useRef, useState } from 'react'
import { harnessName } from '../../agents/harnesses'
import { ReviewBar } from '../../review/ReviewBar'
import { mergedChip } from '../../sidebar/mergeBadge'
import { overlapLines } from '../../sidebar/overlapChip'
import { openOverlap, useOverlapChip } from '../../sidebar/useOverlapChip'
import { openInBrowser } from '../../shell/openInBrowser'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { KIND_LABEL, KIND_LETTER } from './changeKinds'
import { Button, IconButton } from '../../ui/Button'
import { Chip } from '../../ui/Chip'
import { EmptyState } from '../../ui/EmptyState'
import { Menu, type MenuAnchor } from '../../ui/Menu'
import { Segmented } from '../../ui/Segmented'
import { headerActions, landLabel, landNote, landOffer, landTitle, pushOffer, type HeaderAction } from './landOffer'
import { PullRequestChecks } from './PullRequestChecks'
import type { PaneNode, Worktree, WorktreeLog, WorktreeStatus } from '@shared/entities'
import { fileColumnIn, isCommitLeaf, shownTabId } from '@shared/filePane'
import { CheckoutMissing } from '../CheckoutMissing'
import { askerOf, conflictHeadline, updateSides } from './conflictState'
import { ContextSection } from './ContextSection'
import { ChildrenSection } from './ChildrenSection'
import { ChangeRows } from './ChangeRows'
import { CommitBox } from './CommitBox'
import { SectionHead } from './SectionHead'
import { useScmView } from './scmView'
import {
  amendBlocker,
  canDiscard,
  counted,
  directoryOf,
  fileNameOf,
  refLine,
  sectionCount,
  sections
} from './sourceControl'

export function ChangesTab(): React.JSX.Element | null {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const changes = useWorkspaceStore((state) => (worktreeId ? state.changes[worktreeId] : undefined))
  const selectedPath = useWorkspaceStore((state) => state.selectedChangePath)
  const selectChange = useWorkspaceStore((state) => state.selectChange)
  const stagedPaths = useWorkspaceStore((state) => (worktreeId ? state.stagedPaths[worktreeId] : undefined) ?? NONE)
  const stagePaths = useWorkspaceStore((state) => state.stagePaths)
  const unstageAll = useWorkspaceStore((state) => state.unstageAll)
  const hunkPending = useWorkspaceStore((state) => state.hunkPending)
  const log = useWorkspaceStore((state) => (worktreeId ? state.logs[worktreeId] : undefined))
  const branch = useWorkspaceStore((state) => (worktreeId ? state.branchChanges[worktreeId] : undefined))
  const status = useWorkspaceStore((state) => (worktreeId ? state.statuses[worktreeId] : undefined))
  const push = useWorkspaceStore((state) => (worktreeId ? state.pushes[worktreeId] : undefined))
  const pushing = useWorkspaceStore((state) => state.pushing)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const landing = useWorkspaceStore((state) => (worktreeId ? state.landings[worktreeId] : undefined))
  const openingPullRequest = useWorkspaceStore((state) => state.openingPullRequest)
  const createPullRequest = useWorkspaceStore((state) => state.createPullRequest)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openCommit = useWorkspaceStore((state) => state.openCommit)
  const rereadChanges = useWorkspaceStore((state) => state.rereadChanges)
  const updating = useWorkspaceStore((state) => state.updating)
  const updateError = useWorkspaceStore((state) => (worktreeId ? state.updateErrors[worktreeId] : undefined))
  const updateWorktree = useWorkspaceStore((state) => state.updateWorktree)
  const abortUpdate = useWorkspaceStore((state) => state.abortUpdate)
  const continueUpdate = useWorkspaceStore((state) => state.continueUpdate)
  const resolveConflict = useWorkspaceStore((state) => state.resolveConflict)
  const askToResolve = useWorkspaceStore((state) => state.askToResolve)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  // The running agent is asked; with none, the default agent is started for it.
  const asker = useWorkspaceStore((state) => (worktreeId === null ? null : askerOf(state, worktreeId)))
  const child = useWorkspaceStore((state) => childOf(state.worktrees, worktreeId))
  const baseRef = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId)
    if (worktree?.parentId !== undefined && worktree.baseRef !== undefined) return worktree.baseRef
    return state.projects.find((project) => project.id === worktree?.projectId)?.baseRef
  })
  const shownCommit = useWorkspaceStore((state) =>
    worktreeId ? shownCommitIn(state.layouts[worktreeId]?.root ?? null) : null
  )
  const view = useScmView((state) => state.view)
  const setView = useScmView((state) => state.setView)
  const folded = useScmView((state) => state.folded)
  const toggleFold = useScmView((state) => state.toggleFold)
  const overlap = useOverlapChip(worktreeId)
  const [moreAt, setMoreAt] = useState<{ at: MenuAnchor; opener: HTMLElement } | null>(null)
  const checkoutPath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const missing = useWorkspaceStore((state) =>
    state.worktrees.some((entry) => entry.id === worktreeId && entry.missing === true)
  )

  if (!worktreeId) return null
  // No list is coming, and zeros from no checkout are not a clean tree.
  if (missing || status?.missing === true) {
    return (
      <section className="changes" aria-label="Changes in this worktree">
        <CheckoutMissing worktree={{ id: worktreeId, path: checkoutPath ?? '' }} />
      </section>
    )
  }

  const sides = updateSides(worktrees, projects, worktreeId)
  const shown = sections(changes, branch, stagedPaths)
  const ticked = new Set(stagedPaths)
  const conflictRows = shown.conflicts
  const listedRows = shown.staged.length + shown.unstaged.length
  const midway = status?.operation
  const base = baseRef ?? log?.baseRef
  const open = (key: string): boolean => folded[`section:${key}`] !== true
  const fold = (key: string) => () => toggleFold(`section:${key}`)

  const land = midway === undefined ? landOffer(landing, status) : null
  // Nothing is pushed from the middle of a rebase, nor once the branch has landed.
  const pushed = midway === undefined && land?.kind !== 'merged' ? pushOffer(status, push, landing?.remote) : null
  const header = headerActions({
    land,
    push: pushed,
    updateFrom: conflictRows.length === 0 ? updateFrom(status, base, child) : null,
    uncommitted: listedRows > 0,
    ahead: status?.ahead ?? 0
  })
  const next = header.shown
  const labelOf = (action: HeaderAction): string => {
    if (action.kind === 'update') return updating === worktreeId ? 'Updating…' : `Update from ${action.from}`
    if (action.kind === 'land') {
      return action.offer.kind === 'create-pr' && openingPullRequest ? 'Creating…' : landLabel(action.offer)
    }
    if (action.offer.kind === 'review') return 'Open Review'
    return PUSH_LABEL[action.offer.kind][push?.phase === 'pushing' ? 1 : 0]
  }
  const busy = (action: HeaderAction): boolean =>
    action.kind === 'update'
      ? updating !== null
      : action.kind === 'push'
        ? action.offer.kind !== 'review' && pushing
        : action.offer.kind === 'create-pr' && openingPullRequest
  // A land with uncommitted work runs: its dialog commits first. Anything else noted is blocked.
  const blockedBy = (action: HeaderAction): string | undefined =>
    action.kind === 'land' && action.offer.kind !== 'open-pr' && action.offer.uncommitted === undefined
      ? landNote(action.offer)
      : undefined
  const act = (action: HeaderAction): void => {
    if (action.kind === 'update') void updateWorktree(worktreeId)
    else if (action.kind === 'push') {
      if (action.offer.kind === 'review') openInBrowser(action.offer.url)
      else void pushActiveWorktree()
    } else if (action.offer.kind === 'merge') openDialog({ kind: 'confirm-merge', worktreeId })
    else void createPullRequest(worktreeId)
  }
  const landAfterCommit = (): void => {
    if (land?.kind === 'merge') openDialog({ kind: 'confirm-merge', worktreeId })
    else if (land?.kind === 'create-pr') void createPullRequest(worktreeId)
  }
  const discardable = shown.unstaged.filter(canDiscard).map((change) => change.path)
  const lastCommit = log?.commits[0]

  return (
    <section className="changes" aria-label="Changes in this worktree">
      {status ? (
        <div className="changes__head">
          <span className="changes__ref" title={`↑ ${status.upstream ?? log?.baseRef ?? ''}  ↓ ${log?.baseRef ?? ''}`}>
            {refLine(status.branch, base, status.ahead, status.behind)}
          </span>
          <IconButton icon="reload" label="Refresh" onClick={() => rereadChanges(worktreeId)} />
          <Segmented
            label="View"
            options={[
              { value: 'list', label: 'List' },
              { value: 'tree', label: 'Tree' }
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      ) : null}
      {status ? (
        <div className="changes__actions">
          {land?.kind === 'merged' ? <Chip title={mergedChip(landing).title}>{mergedChip(landing).label}</Chip> : null}
          {land?.kind === 'merged' || (landing !== undefined && land === null && midway === undefined) ? (
            <Button size="sm" onClick={() => void removeWorktree(worktreeId)}>
              Delete Worktree…
            </Button>
          ) : null}
          {next === null ? null : (
            <Button
              size="sm"
              variant={header.primary ? 'primary' : 'secondary'}
              disabled={busy(next) || blockedBy(next) !== undefined}
              title={next.kind === 'land' ? landTitle(next.offer) : undefined}
              onClick={() => act(next)}
            >
              {labelOf(next)}
            </Button>
          )}
          <ReviewBar worktreeId={worktreeId} changed={listedRows > 0 || (branch?.changes.length ?? 0) > 0} />
          {header.more.length === 0 ? null : (
            <IconButton
              icon="more"
              label="More actions"
              size="sm"
              className="changes__more"
              aria-haspopup="menu"
              aria-expanded={moreAt !== null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const at: MenuAnchor = { x: rect.right, y: rect.bottom + 4, align: 'right' }
                setMoreAt(moreAt === null ? { at, opener: event.currentTarget } : null)
              }}
            />
          )}
        </div>
      ) : null}
      {status && landing?.pullRequest !== undefined && landing.pullRequest.state !== 'merged' ? (
        <PullRequestChecks worktreeId={worktreeId} pull={landing.pullRequest} />
      ) : null}
      {overlapLines(overlap).map((line) => (
        <button
          type="button"
          key={line.text}
          className={`changes__overlap${line.conflict ? ' changes__overlap--conflict' : ''}`}
          title={overlap?.title}
          onClick={() => openOverlap(worktreeId, line.entry)}
        >
          <span aria-hidden="true">⚠</span> {line.text}
        </button>
      ))}
      {updateError === undefined ? null : (
        <p className="changes__updateFailed" role="alert">
          {updateError}
        </p>
      )}
      {push?.phase === 'failed' ? (
        <PushFailed error={push.error} detail={push.detail} retry={() => void pushActiveWorktree()} busy={pushing} />
      ) : null}
      {listedRows > 0 && midway === undefined ? (
        <CommitBox
          worktreeId={worktreeId}
          shown={shown}
          land={land}
          remote={landing?.remote !== false}
          amend={amendBlocker(status, log)}
          lastMessage={lastCommit?.message ?? lastCommit?.subject ?? ''}
          onLand={landAfterCommit}
        />
      ) : null}

      <div className="changes__scroll">
        {conflictRows.length > 0 || midway !== undefined ? (
          <section className="changes__conflicts" aria-label="Conflicts">
            <p className="changes__conflictHead">
              {midway === undefined
                ? `${conflictRows.length} conflicted`
                : conflictHeadline(midway, sides, conflictRows.length)}
            </p>
            <ul className="changes__list">
              {conflictRows.map((change) => (
                <li
                  className={`changes__item changes__item--conflict${
                    change.path === selectedPath ? ' changes__item--selected' : ''
                  }`}
                  key={change.path}
                >
                  <button
                    type="button"
                    className="change"
                    aria-current={change.path === selectedPath ? 'true' : undefined}
                    title={change.path}
                    onClick={() => selectChange(change.path)}
                  >
                    <span className="change__kind change__kind--conflicted" aria-label={KIND_LABEL.conflicted}>
                      {KIND_LETTER.conflicted}
                    </span>
                    <span className="change__path">
                      <span className="change__name">{fileNameOf(change.path)}</span>
                      {directoryOf(change.path) === '' ? null : (
                        <span className="change__dir">{directoryOf(change.path)}</span>
                      )}
                    </span>
                    <span className={`change__where${change.markers === 0 ? ' change__where--resolved' : ''}`}>
                      {change.markers === 0 ? 'Resolved' : 'Unresolved'}
                    </span>
                  </button>
                  <span className="change__resolve">
                    <button
                      type="button"
                      className={`change__discard${change.markers === 0 ? ' change__discard--go' : ''}`}
                      aria-label={`Mark ${change.path} Resolved`}
                      onClick={() => void resolveConflict(worktreeId, change.path)}
                    >
                      Mark Resolved
                    </button>
                    <button
                      type="button"
                      className="change__discard"
                      aria-label={`Take Ours for ${change.path}`}
                      title={`${sides.task}’s version`}
                      onClick={() => void resolveConflict(worktreeId, change.path, 'ours')}
                    >
                      Take Ours
                    </button>
                    <button
                      type="button"
                      className="change__discard"
                      aria-label={`Take Theirs for ${change.path}`}
                      title={`${sides.incoming}’s version`}
                      onClick={() => void resolveConflict(worktreeId, change.path, 'theirs')}
                    >
                      Take Theirs
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="changes__conflictActions">
              {conflictRows.length > 0 ? (
                <button
                  type="button"
                  className="button button--small button--primary"
                  disabled={asker === null}
                  onClick={() => void askToResolve(worktreeId)}
                >
                  {asker === null ? 'Ask Agent to Resolve' : `Ask ${harnessName(asker)} to Resolve`}
                </button>
              ) : null}
              {midway === undefined ? null : (
                <>
                  <button
                    type="button"
                    className={`button button--small${conflictRows.length === 0 ? ' button--primary' : ''}`}
                    disabled={conflictRows.length > 0 || updating !== null}
                    onClick={() => void continueUpdate(worktreeId)}
                  >
                    Continue
                  </button>
                  <button type="button" className="button button--small" onClick={() => void abortUpdate(worktreeId)}>
                    Abort
                  </button>
                </>
              )}
            </div>
          </section>
        ) : null}

        {changes === undefined ? (
          <p className="changes__empty">Reading…</p>
        ) : listedRows === 0 && shown.unlisted === 0 ? (
          conflictRows.length > 0 || midway !== undefined ? null : (
            <EmptyState
              title={emptyChangesLabel(log)}
              {...(lastCommit === undefined
                ? {}
                : {
                    hint: (
                      <button
                        type="button"
                        className="commit__open changes__last"
                        title={`${lastCommit.author} · ${lastCommit.committedAt}`}
                        onClick={() => openCommit(worktreeId, lastCommit)}
                      >
                        <span className="commit__sha">{lastCommit.shortSha}</span>{' '}
                        <span className="commit__subject">{lastCommit.subject}</span>
                      </button>
                    )
                  })}
            />
          )
        ) : null}

        {sectionCount(shown, 'staged') === 0 ? null : (
          <section className="changes__group" aria-label="Staged Changes">
            <SectionHead
              title="Staged Changes"
              count={counted(sectionCount(shown, 'staged'))}
              open={open('staged')}
              onToggle={fold('staged')}
            >
              <IconButton
                icon="minimize"
                label="Unstage All Changes"
                size="sm"
                disabled={hunkPending}
                onClick={() => void unstageAll(worktreeId)}
              />
            </SectionHead>
            {open('staged') ? (
              <ChangeRows worktreeId={worktreeId} section="staged" rows={shown.staged} view={view} ticked={ticked} />
            ) : null}
            {open('staged') && shown.unlistedIn === 'staged' && shown.unlisted > 0 ? (
              <p className="changes__note">+{counted(shown.unlisted)} more</p>
            ) : null}
          </section>
        )}

        {sectionCount(shown, 'unstaged') === 0 ? null : (
          <section className="changes__group" aria-label="Changes">
            <SectionHead
              title="Changes"
              count={counted(sectionCount(shown, 'unstaged'))}
              open={open('unstaged')}
              onToggle={fold('unstaged')}
            >
              {discardable.length === 0 ? null : (
                <IconButton
                  icon="discard"
                  label="Discard All Changes…"
                  size="sm"
                  disabled={hunkPending}
                  onClick={() =>
                    openDialog({ kind: 'confirm-discard', worktreeId, path: discardable[0] ?? '', paths: discardable })
                  }
                />
              )}
              <IconButton
                icon="plus"
                label="Stage All Changes"
                size="sm"
                onClick={() => stagePaths(shown.unstaged.map((change) => change.path))}
              />
            </SectionHead>
            {open('unstaged') ? (
              <ChangeRows
                worktreeId={worktreeId}
                section="unstaged"
                rows={shown.unstaged}
                view={view}
                ticked={ticked}
              />
            ) : null}
            {open('unstaged') && shown.unlistedIn === 'unstaged' && shown.unlisted > 0 ? (
              <p className="changes__note">+{counted(shown.unlisted)} more</p>
            ) : null}
          </section>
        )}

        <ChildrenSection worktreeId={worktreeId} />

        {shown.committed.length === 0 ? null : (
          <section className="changes__group" aria-label="Committed on branch">
            <SectionHead
              title="Committed on branch"
              count={counted(shown.committed.length + shown.committedUnlisted)}
              hint={`vs ${log?.baseRef ?? base ?? ''}`}
              open={open('committed')}
              onToggle={fold('committed')}
            />
            {open('committed') ? (
              <ChangeRows
                worktreeId={worktreeId}
                section="committed"
                rows={shown.committed}
                view={view}
                ticked={ticked}
              />
            ) : null}
            {open('committed') && shown.committedUnlisted > 0 ? (
              <p className="changes__note">+{counted(shown.committedUnlisted)} more</p>
            ) : null}
          </section>
        )}

        {log?.unavailable !== undefined ? (
          <p className="commits__unknown" title={log.unavailable}>
            Could not read this branch’s commits
          </p>
        ) : null}

        {log && log.commits.length > 0 ? (
          <section className="commits" aria-label="Commits this worktree has made">
            <SectionHead
              title="Commits"
              count={`${log.commits.length}${log.truncated ? '+' : ''}`}
              hint={`Not in ${log.baseRef}`}
              open={open('commits')}
              onToggle={fold('commits')}
            />
            {open('commits') ? (
              <ul className="commits__list">
                {log.commits.map((commit) => (
                  <li className={`commit${commit.sha === shownCommit ? ' commit--selected' : ''}`} key={commit.sha}>
                    <button
                      type="button"
                      className="commit__open"
                      aria-current={commit.sha === shownCommit ? 'true' : undefined}
                      title={`${commit.author} · ${commit.committedAt}`}
                      onClick={() => openCommit(worktreeId, commit)}
                    >
                      <span className="commit__sha">{commit.shortSha}</span>{' '}
                      <span className="commit__subject">{commit.subject}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <ContextSection worktreeId={worktreeId} fold={{ open: open('context'), onToggle: fold('context') }} />
      </div>

      {moreAt === null || header.more.length === 0 ? null : (
        <Menu
          label="More actions"
          anchor={moreAt.at}
          opener={moreAt.opener}
          onClose={() => setMoreAt(null)}
          items={header.more.map((action) => {
            const blocked = blockedBy(action)
            return {
              label: labelOf(action),
              onChoose: () => act(action),
              ...(blocked === undefined ? {} : { disabled: true, hint: blocked })
            }
          })}
        />
      )}
    </section>
  )
}

/** Whether the worktree is a child, which updates from and lands in its parent. */
export function childOf(worktrees: readonly Worktree[], worktreeId: string | null): boolean {
  return worktrees.some((worktree) => worktree.id === worktreeId && worktree.parentId !== undefined)
}

/** The base's branch name (`main` for `origin/main`), or `Parent`, when the worktree is behind it and nothing is mid-way; else null. */
export function updateFrom(
  status: WorktreeStatus | undefined,
  baseRef: string | undefined,
  child = false
): string | null {
  if (!status || status.missing || status.behind === 0 || status.operation !== undefined) return null
  if (child) return 'Parent'
  if (baseRef === undefined) return 'base'
  const slash = baseRef.indexOf('/')
  return slash === -1 ? baseRef : baseRef.slice(slash + 1)
}

/** A failed push as one line under the header: git's words behind Details, and Retry. */
function PushFailed({
  error,
  detail,
  retry,
  busy
}: {
  error: string
  detail: string
  retry: () => void
  busy: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const line = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (line.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  return (
    <div className="changes__pushFailed" ref={line}>
      <span className="changes__pushFailedText" role="alert">
        {pushFailedText(error)}
      </span>
      <button type="button" className="button button--small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Details
      </button>
      <button type="button" className="button button--small" disabled={busy} onClick={retry}>
        Retry
      </button>
      {open ? (
        <pre
          className="changes__pushDetail"
          role="dialog"
          aria-label="git output"
          tabIndex={-1}
          ref={(pre) => pre?.focus()}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  )
}

/** `Push failed: origin not found`, or just `Push failed` when git gave no clause. */
export function pushFailedText(error: string): string {
  return error === 'Push failed' ? error : `Push failed: ${error}`
}

/** The commit the file column is showing, if its shown tab is one. */
export function shownCommitIn(root: PaneNode | null): string | null {
  const column = fileColumnIn(root)
  if (column === null) return null
  const shown = column.children.find((child) => child.kind === 'leaf' && child.terminalId === shownTabId(column))
  return isCommitLeaf(shown) ? shown.commit : null
}

const NONE: string[] = []

const PUSH_LABEL = { push: ['Push', 'Pushing…'], publish: ['Publish Branch', 'Publishing…'] } as const

/** What an empty changes list means; "No changes" is wrong when the base could not be compared. */
export function emptyChangesLabel(log: WorktreeLog | undefined): string {
  return log?.unavailable !== undefined ? 'Nothing uncommitted' : 'No changes'
}
