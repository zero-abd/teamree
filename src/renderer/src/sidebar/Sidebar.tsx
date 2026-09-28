// A short rail of places to go, then projects and their worktrees with each worktree's panes
// underneath, then a foot with Settings, Appearance and Help. The rail's search is a button
// wearing a field's clothes: it opens the palette rather than being a second, weaker search.

import { useEffect, useMemo, useRef } from 'react'
import { teammatesHeard, type Worktree } from '@shared/entities'
import { hasResumable } from '../agents/harnesses'
import { cliActionLabel, cliTitle, offerCliInstall } from '../dialogs/cliInstallModel'
import { attentionByPane } from '../state/paneAttention'
import { useNow } from '../state/useNow'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Brand } from '../shell/Brand'
import { AddProjectButton } from './AddProjectButton'
import { compareTitle, runName, siblingRuns } from '../compare/siblingRuns'
import { useOpenIn } from './openIn'
import { BaseFreshness, ProjectHead, UnpushedBase } from './ProjectHead'
import { HandoffRows, TeammateGroups } from './TeammateGroups'
import { TeamCueButtons, TeamFaces } from './TeamFaces'
import { teamCues, teamGlance, theirOverlap } from './teamGlance'
import { dataSelector, revealTeamRow } from './teamFold'
import { teammateRows, unheardTeammates, unheardTitle, withoutHandedCopies } from './teammateRows'
import { teamworkControlLabel, teamworkOn, teamworkSummary } from './teamworkSummary'
import { usePaneEvidence, useWatchEvidence } from './usePaneEvidence'
import { treeItems, treeStop, useTreeKeys } from './treeKeys'
import { moveWorktree } from './nestDrag'
import { sortedByProject } from './worktreeOrder'
import { WorktreeRow, type TaskFold } from './WorktreeRow'
import { activityOf, worktreeTones } from './agentRows'
import { flattenTask, taskForest, taskTally, treeTone, type TaskNode } from './taskTree'
import { isDoneStage, taskStages } from '../dashboard/taskRows'
import { useTaskTreeStore } from '../state/taskTreeStore'
import { askingWorktrees, useMessageStore } from '../state/messages'
import { useOverlaps } from '../state/overlapStore'
import { overlapChip } from './overlapChip'
import { openOverlap, overlapNamer } from './useOverlapChip'
import { handedAway, handoffLine, useHandoffs } from '../teamwork/handoffsStore'
import { useReviewRequests } from '../teamwork/reviewRequestsStore'
import { onlineCount } from '../teamwork/homeRows'
import { agentWords, worktreeDisplay, worktreeLabel } from './worktreeDisplay'
import { unreadNotes, useSharedNotes } from '../teamwork/sharedNotesStore'
import { useSidebarView } from '../state/sidebarViewStore'
import { filterProject, keepFlat, narrows, type RowFacts } from './sidebarFilter'
import { CompactToggle, FilterToggle, HideDoneToggle, SidebarFilter } from './SidebarView'
import { Icon } from '../icons/Icon'

export function Sidebar({
  searchHint
}: {
  /** The palette's chord, named in the search's hover; nothing in the sidebar draws a chord. */
  searchHint: string
}): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const landings = useWorkspaceStore((state) => state.landings)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const paneList = useMemo(() => Object.values(terminals), [terminals])
  const now = useNow()
  const collapsed = useWorkspaceStore((state) => state.collapsedProjects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const toggleProject = useWorkspaceStore((state) => state.toggleProject)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const retryWorktree = useWorkspaceStore((state) => state.retryWorktree)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const removeFromTeamree = useWorkspaceStore((state) => state.removeFromTeamree)
  const trashProject = useWorkspaceStore((state) => state.trashProject)
  const renameWorktree = useWorkspaceStore((state) => state.renameWorktree)
  const editingWorktreeName = useWorkspaceStore((state) => state.editingWorktreeName)
  const editWorktreeName = useWorkspaceStore((state) => state.editWorktreeName)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const openIn = useOpenIn()
  const openCompare = useWorkspaceStore((state) => state.openCompare)
  const loadEditors = useWorkspaceStore((state) => state.loadEditors)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const teamwork = useWorkspaceStore((state) => state.teamwork)
  const teammates = useWorkspaceStore((state) => state.teammates)
  const handoffs = useHandoffs((state) => state.byProject)
  const requestReview = useReviewRequests((state) => state.request)
  const cli = useWorkspaceStore((state) => state.cli)
  // What the `!` on Settings is about, named after the row that fixes it.
  const cliFlag = offerCliInstall(cli) ? `CLI: ${cliActionLabel(cli)}` : null
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen)
  const helpOpen = useWorkspaceStore((state) => state.helpOpen)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  const appearanceOpen = useWorkspaceStore((state) => state.appearanceOpen)
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const toggleHelp = useWorkspaceStore((state) => state.toggleHelp)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const closeTeamwork = useWorkspaceStore((state) => state.closeTeamwork)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  const agents = useWorkspaceStore((state) => state.agents)
  const restoring = useWorkspaceStore((state) => state.restoring)
  const kindOf = useMemo(() => agentWords(agents), [agents])
  const conversations = useWorkspaceStore((state) => state.conversations)
  const loadConversations = useWorkspaceStore((state) => state.loadConversations)
  const collapsedTasks = useTaskTreeStore((state) => state.collapsedTasks)
  const overlaps = useOverlaps((state) => state.byProject)
  const setTaskCollapsed = useTaskTreeStore((state) => state.setTaskCollapsed)
  const messages = useMessageStore((state) => state.messages)
  const asking = useMemo(() => askingWorktrees(messages), [messages])
  const stages = useMemo(
    () => taskStages({ worktrees, terminals: paneList, statuses, mergePreviews, landings, asking, now }),
    [worktrees, paneList, statuses, mergePreviews, landings, asking, now]
  )
  const tones = useMemo(() => worktreeTones(worktrees, paneList, asking, now), [worktrees, paneList, asking, now])
  const titleOf = (worktreeId: string): string => {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    return worktree === undefined ? '' : worktreeDisplay(worktree, kindOf).title
  }
  const tree = useRef<HTMLDivElement | null>(null)
  const treeKeys = useTreeKeys(tree)
  const filterField = useRef<HTMLInputElement | null>(null)
  const query = useSidebarView((state) => state.query)
  const quick = useSidebarView((state) => state.quick)
  const compact = useSidebarView((state) => state.compact)
  const buttonsOnHover = useWorkspaceStore((state) => state.appearance.projectButtons === false)
  const openDone = useSidebarView((state) => state.openDone)
  const byAttention = useSidebarView((state) => state.byAttention)
  const view = useMemo(() => ({ query, quick, compact, openDone }), [query, quick, compact, openDone])
  const toggleDone = useSidebarView((state) => state.toggleDone)
  const revealSeq = useSidebarView((state) => state.revealSeq)
  const picked = useSidebarView((state) => state.picked)
  const askFilter = useSidebarView((state) => state.askFilter)
  const narrowing = narrows(view)

  // Which editors are on this machine, asked once from the one thing always
  // mounted while a row exists.
  useEffect(() => {
    void loadEditors()
  }, [loadEditors])

  // Each project's rows as the field and chips leave them; a row picked since they changed stays.
  const groups = useMemo(() => {
    const factsOf = (worktree: Worktree): RowFacts => {
      const status = statuses[worktree.id]
      const dirty = status !== undefined && status.staged + status.unstaged + status.untracked + status.conflicted > 0
      return {
        name: worktree.name,
        title: worktreeDisplay(worktree, kindOf).title,
        branch: worktree.branch,
        ...(worktree.issue === undefined ? {} : { issue: worktree.issue.number }),
        stage: stages[worktree.id],
        changed: dirty || (mergePreviews[worktree.id]?.ahead ?? 0) > 0
      }
    }
    return sortedByProject(projects, worktrees, byAttention, (id) => tones[id] ?? null).map(({ project, rows }) => {
      const filtered = filterProject(rows, factsOf, view, {
        keep: picked === activeWorktreeId ? picked : null,
        doneOpen: view.openDone.includes(project.id)
      })
      return { project, rows, shown: filtered.rows, context: filtered.context, folded: filtered.folded }
    })
  }, [projects, worktrees, statuses, mergePreviews, stages, kindOf, view, activeWorktreeId, picked, byAttention, tones])

  // Only the panes of worktrees actually rendered are read; a collapsed project costs nothing.
  const onScreen = useMemo(() => {
    const shown = new Set(
      groups.flatMap((group) =>
        collapsed[group.project.id] && !narrowing ? [] : group.shown.map((worktree) => worktree.id)
      )
    )
    return paneList.filter((terminal) => shown.has(terminal.worktreeId))
  }, [collapsed, groups, narrowing, paneList])

  const evidence = usePaneEvidence(onScreen, terminals)
  // With more than one pane asking, only the open worktree's spell their answers out.
  const askingPanes = onScreen.filter(
    (terminal) => terminal.screenMenu !== undefined && activityOf(terminal) === 'waiting'
  ).length
  // Asked once for the whole sidebar: a question about the window, not a row.
  const unread = useUnreadPanes()
  const watching = useWorkspaceStore((state) => state.watchers)

  // The panes themselves are in the workspace; the sidebar only says which
  // rows are watched and quotes what they have printed.
  const watches = useWorkspaceStore((state) => state.watches)
  const toggleWatchedPane = useWorkspaceStore((state) => state.toggleWatchedPane)
  const answerTeammatePane = useWorkspaceStore((state) => state.answerTeammatePane)

  const watchEvidence = useWatchEvidence()

  // Teamwork is per repository, so the app-level entry picks the one whose
  // worktree is open, else the first. Undefined before any has been added, when it joins one.
  const active = worktrees.find((entry) => entry.id === activeWorktreeId)
  const railProject = projects.find((project) => project.id === active?.projectId) ?? projects[0]
  const notesUnread = useSharedNotes((state) => unreadNotes(state))
  const online = railProject === undefined ? 0 : onlineCount(teammates[railProject.id], teamwork[railProject.id])
  const pageOpen = dashboardOpen || settingsOpen || helpOpen || teamworkProjectId !== null

  // A new filter starts the list from its top; declared first, so on mount the open row still wins.
  useEffect(() => {
    if (tree.current !== null) tree.current.scrollTop = 0
  }, [query, quick])

  // Whoever picked it, the open row comes into view; `nearest` leaves a row already on screen alone.
  useEffect(() => {
    if (activeWorktreeId === null) return
    const row = [...(tree.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? [])].find(
      (entry) => entry.dataset.worktreeId === activeWorktreeId
    )
    row?.querySelector('.worktree__row')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeWorktreeId, revealSeq])

  // Counted while the projects are drawn, for the one empty line a filter can leave.
  let sectionsDrawn = 0
  const leaveFilter = (): void => {
    const items = tree.current === null ? [] : treeItems(tree.current)
    ;(narrowing ? items[0] : treeStop(items, null))?.focus()
  }
  const openFirstShown = (): void => {
    const first = groups.flatMap((group) => group.shown.filter((worktree) => !group.context.has(worktree.id)))[0]
    if (first === undefined) return
    // Return asks for that worktree, so its pane may take the keyboard from the field.
    filterField.current?.blur()
    void openWorktree(first.id)
  }

  return (
    <div
      className={`sidebar${pageOpen ? ' sidebar--page' : ''}${compact ? ' sidebar--compact' : ''}${
        buttonsOnHover ? ' sidebar--project-buttons-hover' : ''
      }`}
      data-region="sidebar"
    >
      {/* The top edge of the window, on this side of the seam: the lockup, and
          the one control that puts the sidebar away. On macOS the window
          buttons sit on this row too, and it is what the window is dragged by
          — the stylesheet makes it a drag region and exempts the button. The
          same command is a row in the palette and the menu bar, which is where
          its chord is taught; the way back is the strip's left end. */}
      <header className="sidebar__brand">
        <Brand />
        <button
          type="button"
          className="shell__toggle"
          title="Hide sidebar"
          aria-label="Hide sidebar"
          onClick={toggleSidebar}
        >
          <Icon name="sidebar-toggle" />
        </button>
      </header>

      <nav className="rail" aria-label="Go to">
        {/* A button, not an input: it opens the palette, which is the search
            this app actually has. Dressed as a field for where the eye goes. */}
        <button
          type="button"
          className="rail__search"
          aria-label="Search worktrees and commands"
          title={`Search ${searchHint}`}
          onClick={() => openDialog({ kind: 'palette' })}
        >
          <Icon name="search" />
          <span className="rail__search-text">Search</span>
        </button>

        <ul className="rail__list">
          <li>
            <button
              type="button"
              className={`rail__link${teamworkProjectId !== null ? ' rail__link--current' : ''}`}
              aria-current={teamworkProjectId !== null ? 'page' : undefined}
              title={railProject === undefined ? 'Join a Team…' : `Teamwork in ${railProject.name}`}
              onClick={() => {
                if (teamworkProjectId !== null) closeTeamwork()
                else if (railProject) openTeamwork(railProject.id)
                else openDialog({ kind: 'join-invitation' })
              }}
            >
              <Icon name="team" />
              <span>Teamwork</span>{' '}
              {notesUnread > 0 ? (
                <span className="rail__badge" role="img" aria-label={`${notesUnread} unread`}>
                  {notesUnread}
                </span>
              ) : online > 0 ? (
                <span className="rail__meta rail__meta--online" aria-hidden="true">{`${online} online`}</span>
              ) : null}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`rail__link${dashboardOpen ? ' rail__link--current' : ''}`}
              aria-current={dashboardOpen ? 'page' : undefined}
              title="All Panes, by what needs you"
              onClick={toggleDashboard}
            >
              <Icon name="all-panes" />
              <span>All Panes</span>
              {paneList.length > 0 ? (
                <span className="rail__meta" aria-hidden="true">
                  {paneList.length}
                </span>
              ) : null}
            </button>
          </li>
        </ul>
      </nav>

      <nav
        className="sidebar__projects"
        aria-label="Projects and worktrees"
        onKeyDown={(event) => {
          // `/` from anywhere in the list but a field; ⌘⌥F is the menu's way in.
          const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
          if (event.key !== '/' || typing || event.metaKey || event.ctrlKey || event.altKey) return
          event.preventDefault()
          askFilter()
        }}
      >
        <div className="sidebar__head">
          <h2 className="sidebar__head-title">Projects</h2>
          <div className="sidebar__head-actions">
            {projects.length === 0 ? null : (
              <>
                {/* How rows are drawn: under the pointer, or while on. */}
                <span className="sidebar__head-view">
                  <HideDoneToggle />
                  <CompactToggle />
                </span>
                <FilterToggle />
              </>
            )}
            <AddProjectButton />
          </div>
        </div>
        {projects.length === 0 ? null : (
          <SidebarFilter field={filterField} onLeave={leaveFilter} onSubmit={openFirstShown} />
        )}

        {/* One Tab stop; the arrows walk the rows. The other controls in it are the mouse's, each
            reachable by key elsewhere: the row menu, ⌘N, the rail. */}
        <div
          className="sidebar__scroll"
          role="tree"
          aria-label="Worktrees"
          ref={tree}
          onKeyDown={treeKeys.onKeyDown}
          onFocus={treeKeys.onFocus}
        >
          {/* The instruction that used to follow this — "Add a repository." —
              named the button directly above it, which is the plus in this
              section's own header, labelled "Add project". */}
          {projects.length === 0 && !restoring ? <p className="sidebar__empty">No projects yet</p> : null}

          {/* Grouped by the same function the next-worktree chord walks, so
              the chord moves down this list rather than through whatever order
              the runtime answered in. See `worktreeOrder.ts`. */}
          {groups.map(({ project, rows, shown, context, folded: foldedMine }) => {
            // A filter shows its matches wherever they are.
            const isCollapsed = Boolean(collapsed[project.id]) && !narrowing
            const summary = teamworkSummary(teamwork[project.id], now)
            const doneOpen = openDone.includes(project.id)
            // Under the same project: the same repository, checked out elsewhere.
            const allTheirs = teammateRows(
              withoutHandedCopies(
                teammatesHeard(teammates[project.id])?.worktrees ?? [],
                handoffs[project.id]?.outgoing ?? [],
                new Set(rows.map((mine) => mine.id))
              ),
              now,
              watchEvidence
            )
            const glance = teamGlance(teamwork[project.id], teammates[project.id], allTheirs, now)
            const cues = teamCues(glance, handoffs[project.id]?.incoming.length ?? 0)
            const heard = keepFlat(
              allTheirs,
              (row) => ({
                name: row.name,
                ...(row.branch === undefined ? {} : { branch: row.branch }),
                stage: row.stage,
                changed: (row.paths ?? 0) > 0 || (row.ahead ?? 0) > 0,
                theirs: true
              }),
              view,
              doneOpen
            )
            const theirs = heard.rows
            const folded = foldedMine + heard.folded
            if (narrowing && shown.length === 0 && theirs.length === 0 && folded === 0) return null
            sectionsDrawn += 1
            // The whole tree, for a task's tally and fold: the filter hides rows, not children.
            const whole = new Map<string, TaskNode<Worktree>>()
            const index = (node: TaskNode<Worktree>): void => {
              whole.set(node.worktree.id, node)
              node.children.forEach(index)
            }
            taskForest(rows).forEach(index)
            const reading = attentionByPane(watching[project.id])
            // Roster teammates never heard from: not away, and not without worktrees.
            const unheard = unheardTeammates(teammates[project.id])
            const nameOf = overlapNamer(worktrees, teammatesHeard(teammates[project.id])?.worktrees ?? [])
            const canHandOff =
              teamworkOn(teamwork[project.id]) && (teammatesHeard(teammates[project.id])?.teammates.length ?? 0) > 0
            const reviewers = (teammatesHeard(teammates[project.id])?.teammates ?? []).map(
              (teammate) => teammate.handle
            )
            const drawRow = (node: TaskNode<Worktree>, depth: number): React.JSX.Element => {
              const { worktree } = node
              const full = whole.get(worktree.id) ?? node
              const display = worktreeDisplay(worktree, kindOf)
              const label = worktreeLabel(display)
              const siblings = siblingRuns(worktree, worktrees)
              const chip = overlapChip(worktree.id, overlaps[project.id], nameOf)
              const overlapping = (chip?.entries ?? []).filter(
                (entry, index, all) =>
                  !('handle' in entry.with) &&
                  !('base' in entry.with) &&
                  !siblings.some((other) => other.id === entry.with.worktreeId) &&
                  all.findIndex((first) => first.with.worktreeId === entry.with.worktreeId) === index
              )
              const kind = display.agent?.kind
              const twinRun =
                kind !== undefined && siblings.some((other) => worktreeDisplay(other, kindOf).agent?.kind === kind)
              return (
                <WorktreeRow
                  key={worktree.id}
                  worktree={worktree}
                  display={display}
                  depth={depth}
                  {...(full.children.length === 0 ? {} : { task: taskFold(full) })}
                  compact={compact}
                  context={context.has(worktree.id)}
                  onNewChild={() => openDialog({ kind: 'new-task', projectId: project.id, parentId: worktree.id })}
                  onMoveUnder={() => openDialog({ kind: 'move-under', worktreeId: worktree.id })}
                  {...(worktree.parentId === undefined
                    ? {}
                    : { onMoveToTop: () => void moveWorktree(worktree.id, null) })}
                  {...(hasResumable(conversations[worktree.id], agents)
                    ? { onResume: () => openDialog({ kind: 'resume-conversation', worktreeId: worktree.id }) }
                    : {})}
                  onMenuOpen={() => void loadConversations(worktree.id)}
                  {...(canHandOff
                    ? {
                        onHandOff: () => openDialog({ kind: 'hand-off', worktreeId: worktree.id }),
                        reviewers,
                        onRequestReview: (handle: string) => void requestReview(worktree.id, handle)
                      }
                    : {})}
                  handoff={handoffLine(handoffs[project.id]?.outgoing ?? [], worktree.id)}
                  {...(handedAway(handoffs[project.id]?.outgoing ?? [], worktree.id)
                    ? { onRemoveCopy: () => void removeWorktree(worktree.id) }
                    : {})}
                  status={statuses[worktree.id]}
                  mergePreview={mergePreviews[worktree.id]}
                  {...(landings[worktree.id] === undefined ? {} : { landing: landings[worktree.id] })}
                  terminals={paneList}
                  evidence={evidence}
                  watchers={reading}
                  unread={unread}
                  now={now}
                  onFocusTerminal={(terminalId) => revealPane(worktree.id, terminalId)}
                  active={worktree.id === activeWorktreeId}
                  answerChip={askingPanes > 1 && worktree.id !== activeWorktreeId}
                  onOpen={() => void openWorktree(worktree.id)}
                  onRetry={() => retryWorktree(worktree.id)}
                  onRemove={() => void removeWorktree(worktree.id)}
                  onForget={() => void removeFromTeamree({ worktreeId: worktree.id })}
                  onRename={(name) => void renameWorktree(worktree.id, name)}
                  renameAsked={editingWorktreeName === worktree.id}
                  onRenameShown={() => editWorktreeName(null)}
                  onReveal={() => void revealInFinder(worktree.path, `the ${label} checkout`)}
                  onCopyPath={() => void copyToClipboard(worktree.path, `the path to ${label}`)}
                  onCopyBranch={() => void copyToClipboard(worktree.branch, `the branch ${worktree.branch}`)}
                  openIn={openIn(project.id, worktree.path, `the ${label} checkout`, false)}
                  twinRun={twinRun}
                  {...(siblings.length === 0
                    ? {}
                    : { onKeep: () => openDialog({ kind: 'confirm-keep', worktreeId: worktree.id }) })}
                  compareWith={[
                    ...siblings.map((other) => ({
                      label: runName(other, kindOf),
                      onChoose: () => void openCompare(worktree.id, other.id, compareTitle(worktree, other, kindOf))
                    })),
                    ...overlapping.map((entry) => ({
                      label: entry.name,
                      onChoose: () => openOverlap(worktree.id, entry)
                    }))
                  ]}
                  {...(chip === null ? {} : { overlap: { chip, onOpen: (entry) => openOverlap(worktree.id, entry) } })}
                />
              )
            }
            const taskFold = (node: TaskNode<Worktree>): TaskFold => {
              const rolled = treeTone(node, (id) => tones[id] ?? null)
              const from =
                rolled === null ? undefined : node.worktree.id === rolled.from ? undefined : titleOf(rolled.from)
              return {
                collapsed: !narrowing && collapsedTasks[node.worktree.id] === true,
                onCollapse: (collapsed) => setTaskCollapsed(node.worktree.id, collapsed),
                rolled: rolled === null ? null : { tone: rolled.tone, ...(from === undefined ? {} : { from }) },
                tally: taskTally(node, (child) => isDoneStage(stages[child.id] ?? 'stopped')),
                children: node.children.map(
                  (child) => `${titleOf(child.worktree.id)} · ${stages[child.worktree.id] ?? 'stopped'}`
                )
              }
            }
            return (
              <section className="project" key={project.id} data-project-id={project.id}>
                <ProjectHead
                  project={project}
                  collapsed={isCollapsed}
                  count={rows.length}
                  theirs={theirs.length}
                  onToggle={() => toggleProject(project.id)}
                  onNewTask={() => openDialog({ kind: 'new-task', projectId: project.id })}
                  onNewTaskFromIssue={() => openDialog({ kind: 'new-task', projectId: project.id, fromIssue: true })}
                  onOpenBranch={(pullRequests) =>
                    openDialog({
                      kind: 'open-branch',
                      projectId: project.id,
                      ...(pullRequests ? { pullRequests } : {})
                    })
                  }
                  onForget={() => void removeFromTeamree({ projectId: project.id })}
                  onTrash={() => void trashProject(project.id)}
                  meta={
                    <div className="project__meta">
                      <p className="project__base">{project.baseRef}</p>
                      <BaseFreshness project={project} />
                      <UnpushedBase projectId={project.id} />
                    </div>
                  }
                  team={
                    <span className="project__team">
                      <TeamCueButtons
                        cues={cues}
                        onAsking={() => {
                          if (cues.asking === null) return
                          revealTeamRow(
                            project.id,
                            dataSelector('teammate-pane', cues.asking.paneId),
                            cues.asking.handle
                          )
                        }}
                        onHandoff={() => revealTeamRow(project.id, '[data-handoff]')}
                      />
                      {/* Only where teamwork is on; the rail reaches the setup either way. Named with the
                          project, because the rail has a Teamwork entry too. */}
                      {teamworkOn(teamwork[project.id]) ? (
                        <TeamFaces
                          glance={glance}
                          onReveal={(handle) =>
                            revealTeamRow(project.id, dataSelector('teammate-head', handle), handle)
                          }
                          onMore={() => openTeamwork(project.id)}
                        />
                      ) : null}
                      {/* With faces drawn, the control speaks only when something is wrong. */}
                      {teamworkOn(teamwork[project.id]) && !(glance.length > 0 && summary?.tone === 'live') ? (
                        <button
                          type="button"
                          className={`project__teamwork${summary ? ` project__teamwork--${summary.tone}` : ''}`}
                          tabIndex={-1}
                          aria-label={`${teamworkControlLabel(summary)} in ${project.name}`}
                          title={summary ? summary.detail : `Teamwork in ${project.name}`}
                          onClick={() => openTeamwork(project.id)}
                        >
                          {glance.length > 0 && summary
                            ? (summary.short ?? summary.label)
                            : teamworkControlLabel(summary)}
                        </button>
                      ) : null}
                    </span>
                  }
                />

                {isCollapsed ? null : (
                  <ul className="project__worktrees" role="group">
                    {narrowing ? null : <HandoffRows projectId={project.id} />}
                    {taskForest(shown).map((node) => {
                      if (node.children.length === 0) return drawRow(node, 0)
                      // A task and its child tasks share one box.
                      return (
                        <li className="task" role="none" key={`task-${node.worktree.id}`}>
                          <ul className="task__rows" role="none">
                            {flattenTask(node, narrowing ? {} : collapsedTasks).map((entry) =>
                              drawRow(entry.node, entry.depth)
                            )}
                          </ul>
                        </li>
                      )
                    })}
                    <TeammateGroups
                      projectId={project.id}
                      glance={glance}
                      rows={theirs}
                      narrowing={narrowing}
                      watchingPaneIds={watchingIn(watches, project.id)}
                      onWatch={(pane) => toggleWatchedPane(project.id, pane)}
                      onAnswer={(pane, choice) => void answerTeammatePane(project.id, pane, choice)}
                      overlapOf={(rowId) => {
                        const overlap = theirOverlap(rowId, overlaps[project.id], titleOf)
                        return overlap && { ...overlap, onOpen: () => void openWorktree(overlap.worktreeId) }
                      }}
                    />
                    {folded > 0 ? (
                      <li className="project__fold" role="none">
                        <button
                          type="button"
                          className="project__fold-toggle"
                          role="treeitem"
                          aria-level={2}
                          aria-expanded={doneOpen}
                          tabIndex={-1}
                          onClick={() => toggleDone(project.id)}
                          onKeyDown={(event) => {
                            if (event.key !== (doneOpen ? 'ArrowLeft' : 'ArrowRight')) return
                            event.preventDefault()
                            toggleDone(project.id)
                          }}
                        >
                          <Icon
                            name="chevron-right"
                            size={14}
                            className={`chevron${doneOpen ? ' chevron--open' : ''}`}
                          />
                          {`${folded} done`}
                        </button>
                      </li>
                    ) : null}
                    {unheard.length > 0 && !narrowing && !quick.includes('mine') ? (
                      <li className="project__unheard" role="none" title={unheardTitle(unheard)}>
                        {`Nothing heard yet from ${unheard.join(', ')}`}
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            )
          })}
          {narrowing && sectionsDrawn === 0 ? <p className="sidebar__empty">No matches</p> : null}
        </div>
      </nav>

      {/* Where people look for them: under the list, which scrolls above it. */}
      <nav className="sidebar__foot" aria-label="Settings and help">
        <button
          type="button"
          className={`rail__link sidebar__settings${settingsOpen ? ' rail__link--current' : ''}`}
          aria-current={settingsOpen ? 'page' : undefined}
          title={cliFlag === null ? 'Settings' : `Settings · CLI: ${cliTitle(cli)}`}
          aria-label={cliFlag === null ? undefined : `Settings, ${cliFlag}`}
          onClick={() => (cliFlag === null || settingsOpen ? toggleSettings() : openSettings('cli'))}
        >
          <Icon name="settings" />
          <span>Settings</span>
          {/* The CLI link is wrong and Settings › CLI fixes it; pressing Settings goes there. In ink: colour is for agents' state. */}
          {cliFlag === null ? null : (
            <span className="rail__badge" role="img" aria-label={cliFlag}>
              !
            </span>
          )}
        </button>
        <button
          type="button"
          className={`rail__link rail__link--icon${appearanceOpen ? ' rail__link--current' : ''}`}
          aria-pressed={appearanceOpen}
          aria-controls="appearance-sheet"
          aria-label="Appearance"
          title="Appearance"
          onClick={() => showAppearance(!appearanceOpen)}
        >
          <Icon name="appearance" />
        </button>
        <button
          type="button"
          className={`rail__link rail__link--icon${helpOpen ? ' rail__link--current' : ''}`}
          aria-current={helpOpen ? 'page' : undefined}
          aria-label="Help"
          title="Help"
          onClick={toggleHelp}
        >
          <Icon name="help" />
        </button>
      </nav>
    </div>
  )
}

/** The panes of one project this window has open, for the rows to mark. */
function watchingIn(watches: readonly { projectId: string; paneId: string }[], projectId: string): string[] {
  return watches.filter((watch) => watch.projectId === projectId).map((watch) => watch.paneId)
}
