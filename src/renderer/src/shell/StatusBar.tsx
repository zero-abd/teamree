// The bottom rail, the open worktree's strip: branch, git line, keep-awake and memory on the left; agents
// working, asking or failed anywhere, and teammates online, on the right. The runtime only when not ready.

import { Fragment, useMemo } from 'react'
import { changedFiles, type WorktreeStatus } from '@shared/entities'
import { activityOf } from '@shared/paneActivity'
import { attention, dashboardRows } from '../dashboard/dashboardRows'
import { stepNeedingYou } from '../dashboard/needingYou'
import { Icon } from '../icons/Icon'
import { baseFreshness } from '../sidebar/baseFreshness'
import { startedFromLabel } from '../sidebar/worktreeDisplay'
import { aheadTip, behindTip, changedTip, conflictedTip, gitRefs, workingTip, type GitRefs } from '../sidebar/tipText'
import { formatReadAge } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { requestRegionFocus } from './regions'
import { useKeepAwake } from './keepAwake'
import { KeepAwakeControl } from './KeepAwakeControl'
import { ResourcesControl } from './ResourcesControl'
import { onlineCount } from '../teamwork/homeRows'
import { TokensLine } from './TokensLine'

/** What the rail says while the runtime is not ready; nothing is said once it is. */
const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Runtime starting',
  retrying: 'Reconnecting',
  offline: 'Runtime down'
}

export function StatusBar(): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  // Pressed while the changes tab is showing, the one state the click closes.
  const changesOpen = useWorkspaceStore((state) => state.rightPanelOpen && state.rightPanelTab === 'changes')
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  // A page covers the worktree, so its git line would describe something off screen.
  const pageOpen = useWorkspaceStore(
    (state) => state.dashboardOpen || state.settingsOpen || state.helpOpen || state.teamworkProjectId !== null
  )
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const fetching = useWorkspaceStore((state) => state.fetching)
  const fetchProject = useWorkspaceStore((state) => state.fetchProject)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const now = useNow(60_000)

  // The rail is always mounted, so it keeps main told which way sleep should go.
  useKeepAwake()

  const working = Object.values(terminals).filter(
    (terminal) => (terminal.agent ?? terminal.foregroundAgent) !== undefined && activityOf(terminal) === 'working'
  ).length
  const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
  const child = active?.parentId !== undefined
  // The record outlives a status read from before the folder went, and exists before any read.
  const missing = active?.missing === true
  const shownStatus = missing && activeWorktreeId ? missingStatus(activeWorktreeId, status) : status
  const project = projects.find((entry) => entry.id === active?.projectId)
  const fresh = project === undefined ? null : baseFreshness(project, now)
  // In sync with a base that could not be fetched, or was fetched hours ago, is not known.
  const parts =
    shownStatus === undefined
      ? undefined
      : gitParts(
          shownStatus,
          child,
          fresh !== null && !child,
          gitRefs(shownStatus, active?.baseRef ?? project?.baseRef)
        )
  const description = parts?.map((part) => part.text).join(' · ')
  const online = useWorkspaceStore((state) =>
    project === undefined ? 0 : onlineCount(state.teammates[project.id], state.teamwork[project.id])
  )
  // `now` only moves the quiet-for column, which the count does not read.
  const owed = useMemo(
    () => attention(dashboardRows({ terminals: Object.values(terminals), worktrees, projects, layouts, now: 0 })),
    [terminals, worktrees, projects, layouts]
  )
  const first = owed.first
  const connectionLabel = CONNECTION_LABEL[connection.phase] ?? connection.phase

  return (
    <footer className="statusbar">
      {connection.phase === 'ready' ? null : (
        <span
          className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
          data-tip={connection.detail ?? connectionLabel}
        >
          <span className="statusbar__dot" aria-hidden="true" />
          {connectionLabel}
        </span>
      )}

      {active !== undefined && !pageOpen ? (
        <button
          type="button"
          className="statusbar__item statusbar__button statusbar__branch"
          data-tip={`Copy branch · ${startedFromLabel(active)}`}
          aria-label={`Copy Branch ${active.branch}`}
          onClick={() => void copyToClipboard(active.branch, `the branch ${active.branch}`)}
        >
          <Icon name="branch" size={14} />
          <span className="statusbar__text">{active.branch}</span>
        </button>
      ) : null}

      {description !== undefined && shownStatus && !pageOpen ? (
        // The count is in the accessible name too; offered on a clean tree for reading the last commits.
        <button
          type="button"
          className={`statusbar__item statusbar__button statusbar__git${changesOpen ? ' statusbar__button--on' : ''}`}
          aria-pressed={changesOpen}
          aria-label={`Changes, ${description}`}
          data-tip={`Changes · read ${formatReadAge(shownStatus.readAt, Date.now())}`}
          onClick={toggleChanges}
        >
          {parts?.map((part, index) => (
            <Fragment key={part.text}>
              {index === 0 ? null : ' · '}
              <span data-tip={part.tip}>{part.text}</span>
            </Fragment>
          ))}
        </button>
      ) : null}

      {active !== undefined && !pageOpen ? <TokensLine worktreeId={active.id} /> : null}

      {project !== undefined && (fresh !== null || fetching[project.id]) && !pageOpen ? (
        <button
          type="button"
          className={`statusbar__item statusbar__button${
            project.fetch?.failure === undefined ? '' : ' statusbar__stale'
          }`}
          data-tip={`Fetch ${project.baseRef} now`}
          aria-label={`Fetch ${project.baseRef} now${fresh === null ? '' : `, ${fresh}`}`}
          disabled={fetching[project.id] === true}
          onClick={() => void fetchProject(project.id)}
        >
          {fetching[project.id] ? 'fetching…' : fresh}
        </button>
      ) : null}

      <KeepAwakeControl />
      <ResourcesControl />

      <span className="statusbar__spacer" />

      {RUNTIME_IS_SEEDED ? <span className="statusbar__badge">seeded data</span> : null}

      {working === 0 ? null : (
        <span
          className="statusbar__item statusbar__working"
          data-tip={workingTip(working)}
        >{`${working} working`}</span>
      )}

      {first === null ? null : (
        <button
          type="button"
          className="statusbar__item statusbar__button statusbar__attention"
          aria-label={[owed.asking > 0 ? `${owed.asking} asking` : '', owed.failed > 0 ? `${owed.failed} failed` : '']
            .filter(Boolean)
            .join(', ')}
          data-tip={`${first.label} · ${first.worktreeName}`}
          // The next one each press, as Go to Next Needing You walks; the first when it is the one in front.
          onClick={() => {
            const next = stepNeedingYou(useWorkspaceStore.getState(), 1) ?? first
            void revealPane(next.worktreeId, next.terminalId).then(() => requestRegionFocus('panes'))
          }}
        >
          {owed.asking > 0 ? <span className="statusbar__asking">{`${owed.asking} asking`}</span> : null}
          {owed.failed > 0 ? <span className="statusbar__failed">{`${owed.failed} failed`}</span> : null}
        </button>
      )}

      {online === 0 || project === undefined ? null : (
        <button
          type="button"
          className="statusbar__item statusbar__button statusbar__online"
          data-tip={`Teamwork in ${project.name}`}
          onClick={() => openTeamwork(project.id)}
        >
          {`${online} teammate${online === 1 ? '' : 's'} online`}
        </button>
      )}
    </footer>
  )
}

type GitPart = { text: string; tip?: string }

/** The git line: changed files, then ahead and behind, each spelled out in its tip; `clean` alone when in sync is not known. */
function gitParts(status: WorktreeStatus, child: boolean, syncUnknown: boolean, refs: GitRefs): GitPart[] {
  if (status.missing) return [{ text: 'missing' }]
  const changed = changedFiles(status)
  const parts: GitPart[] = []
  if (status.operation !== undefined) parts.push({ text: status.operation === 'rebase' ? 'rebasing' : 'merging' })
  if (status.conflicted > 0)
    parts.push({ text: `${status.conflicted} conflicted`, tip: conflictedTip(status.conflicted) })
  if (changed > 0) parts.push({ text: `${changed} changed`, tip: changedTip(changed) })
  if (status.ahead > 0) parts.push({ text: `${status.ahead} ahead`, tip: aheadTip(status.ahead, refs) })
  if (status.behind > 0)
    parts.push({
      text: child ? `${status.behind} behind parent` : `${status.behind} behind`,
      tip: behindTip(status.behind, refs)
    })
  if (parts.length > 0) return parts
  return [{ text: syncUnknown ? 'clean' : 'clean, in sync' }]
}

/** The zeros of a status with no checkout behind it, whatever was read before the folder went. */
function missingStatus(worktreeId: string, read: WorktreeStatus | undefined): WorktreeStatus {
  const zeros = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  return { worktreeId, branch: read?.branch ?? '', ...zeros, readAt: read?.readAt ?? Date.now(), missing: true }
}
