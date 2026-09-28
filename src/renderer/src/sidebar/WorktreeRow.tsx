// One worktree in the sidebar, in four shapes: ready, still being created,
// failed, and ready on paper but gone from disk. Everything a row can do besides
// being opened is in one menu: right-click, the `⋯`, or the context-menu key.

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import {
  hasCheckout,
  type Terminal,
  type Worktree,
  type WorktreeLanding,
  type WorktreeMergePreview,
  type WorktreeStatus
} from '@shared/entities'
import { slugifyBranchName } from '@shared/branchName'
import { runPaneOf, runState } from '@shared/runCommands'
import { usageLines } from '@shared/usage'
import { AgentGlyph } from '../agents/glyphs'
import { Icon } from '../icons/Icon'
import { windowModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { openInBrowser } from '../shell/openInBrowser'
import { useLedger } from '../state/ledgerStore'
import { askForYou, childDone, firstSentence, useMessageStore, waitedOn } from '../state/messages'
import { rowVisibility } from '../state/rowVisibility'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { PaneAttention } from '../state/paneAttention'
import { useUsageStore } from '../state/usageStore'
import { agentRows, dotClass, TONE_LABEL, worktreeTone, type DotTone } from './agentRows'
import { AskForYou } from './AskForYou'
import { PaneRows } from './PaneRows'
import { listPorts, portChip, portUrl } from './portChip'
import { PortChipView } from './PortChipView'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge, mergedChip } from './mergeBadge'
import type { OverlapChip, OverlapEntry } from './overlapChip'
import { OverlapMark } from './OverlapMark'
import { PullRequestMark } from './PullRequestMark'
import { pullRequestChip } from './pullRequestChip'
import { COMPACT_CHIPS, type ChipRank, type RowChip } from './rowChips'
import { FoldedChips } from './FoldedChips'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'
import { rowSpeech } from './rowSpeech'
import { endNestDrag, NEST_DRAG_TYPE, startNestDrag, useNestDrag, useNestDrop } from './nestDrag'
import { refocus, RowMenu, type MenuClosed, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { WorktreeNameField } from './WorktreeNameField'
import { RunChip, runMenuItems, TEST_CHIP, useRunActions, useRunOffers } from '../workspace/runButtons'
import { useChildren } from '../workspace/rightPanel/childrenStore'
import { agentName, startedFromLabel, worktreeDisplay, worktreeLabel, type WorktreeDisplay } from './worktreeDisplay'

/** A task with child tasks: they sit under it in its box and fold with its panes. */
export type TaskFold = {
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  /** The most urgent dot in its tree, drawn while folded, and the child task it comes from. */
  rolled: { tone: DotTone; from?: string } | null
  tally: { done: number; total: number }
  /** A line per child, its name and stage, for the tally's hover. */
  children: readonly string[]
}

type WorktreeRowProps = {
  worktree: Worktree
  /** How the name is drawn; see `worktreeDisplay`. */
  display?: WorktreeDisplay
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Where its branch can land, and whether it has. */
  landing?: WorktreeLanding
  /** Every terminal in the workspace; the row picks out its own. */
  terminals: Terminal[]
  /** Last line read from each pane, keyed by terminal id. */
  evidence: Readonly<Record<string, string | null>>
  /**
   * Who is reading and typing into each pane, keyed by terminal id. Not
   * decoration: `docs/teamwork.md` rests on nothing being done invisibly.
   */
  watchers: Readonly<Record<string, PaneAttention>>
  /** Panes that have printed since last looked at; read once by the sidebar for every row. */
  unread: ReadonlySet<string>
  now: number
  onFocusTerminal: (terminalId: string) => void | Promise<void>
  active: boolean
  /** Its asking panes offer one `Answer…` instead of their answers; see `PaneRows`. */
  answerChip?: boolean
  onOpen: () => void
  onRetry: () => void
  /** Delete Worktree…: deletes the checkout, a copy kept for Undo. */
  onRemove: () => void
  /** Remove from teamree: forgets the row; the checkout stays. */
  onForget: () => void
  onReveal: () => void
  onCopyPath: () => void
  onCopyBranch: () => void
  onRename: (name: string) => void
  /** Set when the name field is asked for from elsewhere; `onRenameShown` takes the request back. */
  renameAsked?: boolean
  onRenameShown?: () => void
  /** The Open in submenu, the project's editor first. */
  openIn: readonly { label: string; onChoose: () => void }[]
  /** The Compare with submenu: the task's other runs. None leaves the item out. */
  compareWith?: readonly { label: string; onChoose: () => void }[]
  /** Keeps this run and removes the task's others; absent without any. */
  onKeep?: () => void
  /** Another run of the task runs the same agent, so the glyph alone would not tell the rows apart. */
  twinRun?: boolean
  /** Levels under its top-level task. */
  depth?: number
  task?: TaskFold
  /** New Child Task…; absent leaves the item out. */
  onNewChild?: () => void
  /** Move Under…; with it the row can be dragged onto another to nest there. */
  onMoveUnder?: () => void
  /** Move to Top Level; given only to a child. */
  onMoveToTop?: () => void
  /** Resume Conversation…; absent leaves the item out. */
  onResume?: () => void
  /** Called as the menu opens, so what it offers can be re-read. */
  onMenuOpen?: () => void
  /** Files another task or a teammate changes too; the chip's click opens the first. */
  overlap?: { chip: OverlapChip; onOpen: (entry: OverlapEntry) => void }
  /** Hand Off…; absent leaves the item out. */
  onHandOff?: () => void
  /** `Handed to ana` or `Taken by ana`, for its latest offer. */
  handoff?: string | null
  /** Once taken: deletes this copy, asking first as Delete Worktree… does. */
  onRemoveCopy?: () => void
  /** One line: name, dot and chips; no branch line, pane rows or report. */
  compact?: boolean
  /** Shown without matching the filter: a match's parent, or the open row. */
  context?: boolean
}

export function WorktreeRow({
  worktree,
  display = worktreeDisplay(worktree),
  status,
  mergePreview,
  landing,
  terminals,
  evidence,
  watchers,
  unread,
  now,
  active,
  answerChip = false,
  onFocusTerminal,
  onOpen,
  onRetry,
  onRemove,
  onForget,
  onReveal,
  onCopyPath,
  onCopyBranch,
  onRename,
  renameAsked = false,
  onRenameShown,
  openIn,
  compareWith = [],
  onKeep,
  twinRun = false,
  depth = 0,
  task,
  onNewChild,
  onMoveUnder,
  onMoveToTop,
  onResume,
  onMenuOpen,
  overlap,
  onHandOff,
  handoff = null,
  onRemoveCopy,
  compact = false,
  context = false
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  // The record says ready and the disk says otherwise: not ready for anything
  // that touches the checkout, and its own shape for what the row says.
  const missing = worktree.missing === true
  const ready = hasCheckout(worktree)
  // Still focusable when it cannot open, so the tree's arrows reach its menu. A missing one opens on its ways back.
  const openable = !creating && !failed
  // Merged: whether it would merge again says nothing.
  const merged = ready && landing?.merged === true
  const badge = ready && !merged ? mergeBadge(mergePreview) : null
  const pullRequest = landing?.pullRequest?.state === 'open' ? landing.pullRequest : undefined
  const issue = worktree.issue
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const openControl = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const rowElement = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (rowElement.current === null) return
    return rowVisibility.observe(rowElement.current, worktree.id)
  }, [worktree.id])
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    if (!renameAsked) return
    setRenaming(true)
    onRenameShown?.()
  }, [renameAsked, onRenameShown])
  const [panesShown, setPanesShown] = useState(true)
  const wasRenaming = useRef(false)
  const describedBy = useId()
  const drop = useNestDrop({ parentId: worktree.id }, true)
  const dragged = useNestDrag((state) => state.dragging === worktree.id)
  const draggable = ready && !renaming && onMoveUnder !== undefined
  const ask = useMessageStore((state) => askForYou(state.messages, worktree.id))
  // One nobody waits on any more is still drawn, but no longer asks.
  const liveAsk = ask !== undefined && waitedOn(ask) ? ask : undefined
  const heard = useMessageStore((state) => childDone(state.messages, worktree.id))
  // Joined, so the selector answers the same string while nothing changed.
  const claims = useLedger(
    (state) =>
      state.byProject[worktree.projectId]?.worktrees.find((row) => row.worktreeId === worktree.id)?.claims.join('\n') ??
      ''
  )
  const recreateCheckout = useWorkspaceStore((state) => state.recreateCheckout)
  const locateCheckout = useWorkspaceStore((state) => state.locateCheckout)
  const heardFrom = useWorkspaceStore((state) =>
    heard === undefined ? undefined : state.worktrees.find((entry) => entry.id === heard.from.worktreeId)
  )
  const runItems = runMenuItems(useRunOffers(worktree.id), useRunActions(worktree.id))
  const ports = ready
    ? [
        ...new Set(
          listPorts(terminals)
            .filter((entry) => entry.worktreeId === worktree.id)
            .map((entry) => entry.port)
        )
      ]
    : []
  const firstPort = ports[0]
  const firstOverlap = ready ? overlap?.chip.entries[0] : undefined
  const pullLink = ready && landing?.merged !== true ? landing?.pullRequest : undefined

  // A field removed while focused leaves the focus on `document.body`; after a blur it is already elsewhere.
  useEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) openControl.current?.focus()
    wasRenaming.current = renaming
  }, [renaming])

  const openMenu = (at: RowMenuAnchor, from: HTMLElement | null): void => {
    opener.current = from
    onMenuOpen?.()
    setMenuAt(at)
  }

  const closeMenu = (closed?: MenuClosed): void => {
    setMenuAt(null)
    // A menu that leaves the focus on `document.body` costs a keyboard user their place.
    refocus(opener.current ?? openControl.current, closed)
  }

  /** Under the row, for a menu nobody pointed at. */
  const rowAnchor = (): RowMenuAnchor => {
    const rect = openControl.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: rect.left + 12, y: rect.bottom }
  }

  // Last, behind a rule; both ask before anything goes. First once the work has landed: done is what is left.
  const remove: RowMenuItem[] = [
    { label: 'Remove from teamree', onChoose: onForget, separated: !merged },
    { label: 'Delete Worktree…', onChoose: onRemove, danger: true }
  ]
  if (merged) remove.reverse()
  const rest: RowMenuItem[] = [
    ...(failed && worktree.retryable
      ? [{ label: 'Retry', icon: <Icon name="restart" size={14} />, onChoose: onRetry }]
      : []),
    ...(onNewChild !== undefined && ready
      ? [
          {
            label: 'New Child Task…',
            icon: <Icon name="new-task" size={14} />,
            hint: shortcutHint('new-child-task', windowModifier()),
            onChoose: onNewChild
          }
        ]
      : []),
    ...(onMoveUnder !== undefined && ready ? [{ label: 'Move Under…', onChoose: onMoveUnder }] : []),
    ...(onMoveToTop !== undefined && ready ? [{ label: 'Move to Top Level', onChoose: onMoveToTop }] : []),
    ...(onResume !== undefined && ready
      ? [{ label: 'Resume Conversation…', icon: <Icon name="history" size={14} />, onChoose: onResume }]
      : []),
    ...(onHandOff !== undefined && ready && onRemoveCopy === undefined
      ? [{ label: 'Hand Off…', onChoose: onHandOff }]
      : []),
    ...(onRemoveCopy === undefined ? [] : [{ label: 'Remove My Copy…', onChoose: onRemoveCopy }]),
    { label: 'Rename…', icon: <Icon name="rename" size={14} />, onChoose: () => setRenaming(true), separated: merged },
    { label: 'Reveal in Finder', icon: <Icon name="reveal" size={14} />, onChoose: onReveal },
    { label: 'Copy Path', icon: <Icon name="copy" size={14} />, onChoose: onCopyPath },
    { label: 'Copy Branch', onChoose: onCopyBranch },
    { label: 'Open in', icon: <Icon name="folder-open" size={14} />, onChoose: () => {}, items: openIn },
    ...(compareWith.length === 0 ? [] : [{ label: 'Compare with', onChoose: () => {}, items: compareWith }]),
    ...(issue === undefined
      ? []
      : [{ label: `Open Issue #${issue.number}`, onChoose: () => openInBrowser(issue.url) }]),
    ...(onKeep === undefined ? [] : [{ label: 'Keep This Run…', onChoose: onKeep }]),
    ...(pullLink === undefined
      ? []
      : [{ label: `Open Pull Request #${pullLink.number}`, onChoose: () => openInBrowser(pullLink.url) }]),
    ...(firstPort === undefined
      ? []
      : [{ label: `Open localhost:${firstPort}`, onChoose: () => openInBrowser(portUrl(firstPort)) }]),
    ...(firstOverlap === undefined || overlap === undefined
      ? []
      : [{ label: `Open Overlap: ${overlap.chip.label}`, onChoose: () => overlap.onOpen(firstOverlap) }]),
    ...(ready ? runItems.map((item, index) => (index === 0 ? { ...item, separated: true } : item)) : [])
  ]
  // A directory that is not there has nothing to reveal, open or copy; bringing it back or removal is what is left.
  const back: RowMenuItem[] = [
    { label: 'Restore', onChoose: () => void recreateCheckout(worktree.id) },
    { label: 'Locate…', onChoose: () => void locateCheckout(worktree.id) }
  ]
  const items: RowMenuItem[] = missing ? [...back, ...remove] : merged ? [...remove, ...rest] : [...rest, ...remove]
  const rows = ready ? agentRows(terminals, worktree, now, evidence) : []
  const expandable = (rows.length > 0 && !compact) || task !== undefined
  const shown = task === undefined ? panesShown : !task.collapsed
  const show = (next: boolean): void => (task === undefined ? setPanesShown(next) : task.onCollapse(!next))
  // Folded, a task's dot speaks for its whole tree.
  const rolled = task?.collapsed === true ? task.rolled : null
  // A question for you outranks whatever the panes say: the agent is only waiting on the answer.
  const tone = rolled?.tone ?? (liveAsk === undefined ? worktreeTone(rows) : 'waiting')
  const report = liveAsk === undefined ? reportLine(worktree) : null
  // A lone pane that is not working says again what the question or the report above it says.
  const lone = rows.length === 1 ? rows[0] : undefined
  const saidAbove =
    lone !== undefined &&
    (liveAsk !== undefined || (report !== null && lone.activity !== 'working' && lone.activity !== 'waiting'))
  const label = worktreeLabel(display)
  const usage = useUsageStore((state) => state.usage[worktree.id])
  const showCost = useUsageStore((state) => state.showCost)
  const tokens = usageLines(usage, showCost)
  const hoverUsage = useUsageStore((state) => state.hover)
  // The glyph names the agent; words only where it cannot tell two runs apart.
  const agentWord = display.agent?.kind === undefined || twinRun
  // A task's tally, a handoff and a pull request need the second line too, or their chips squeeze the name.
  const pullShown = ready && !merged && landing?.pullRequest !== undefined
  // Under the name, a branch that is only the name slugified says it twice; the name's hover still has it.
  const branch = [worktree.name, display.title].some((name) => slugifyBranchName(name) === display.branch)
    ? undefined
    : display.branch
  const twoLines = !compact && (branch !== undefined || task !== undefined || handoff !== null || pullShown)
  // Rolled up: the collapsed row says something wants reading, the pane rows say which.
  const unreadHere = rows.some((row) => unread.has(row.terminalId))
  const testPane = ready ? runPaneOf(terminals, worktree.id, 'test') : undefined
  const description = rowSpeech({
    ...(creating
      ? { lifecycle: 'creating' as const }
      : failed
        ? { lifecycle: 'failed' as const }
        : missing
          ? { lifecycle: 'missing' as const }
          : {}),
    tone,
    question: liveAsk?.text ?? rows.find((row) => row.activity === 'waiting')?.evidence ?? null,
    ...(rolled?.from === undefined ? {} : { from: rolled.from }),
    unread: unreadHere,
    ...(branch === undefined ? {} : { branch }),
    ...(ready && status !== undefined
      ? { status, child: worktree.parentId !== undefined, ignored: status.ignored ?? 0 }
      : {}),
    ...(merged
      ? {
          landed: landing?.notPushed ? ('merged, not pushed' as const) : ('merged' as const)
        }
      : {}),
    ...(badge === null || mergePreview === undefined ? {} : { merge: mergePreview }),
    ...(pullShown && landing?.pullRequest !== undefined ? { pull: landing.pullRequest } : {}),
    ...(issue === undefined ? {} : { issue: issue.number }),
    ports,
    overlap: ready ? (overlap?.chip ?? null) : null,
    ...(testPane === undefined ? {} : { tests: runState(testPane) }),
    claims: ready && claims !== '' ? claims.split('\n') : [],
    ...(task === undefined ? {} : { tally: task.tally }),
    handoff,
    report
  })

  const git = ready ? summarizeWorktreeStatus(status, worktree.parentId !== undefined) : null
  const gitCounts =
    git !== null &&
    ((!merged && (git.ahead > 0 || git.behind > 0)) || git.tone !== 'quiet' || (status?.ignored ?? 0) > 0)
  const pullChip = pullShown ? pullRequestChip(landing?.pullRequest) : null
  const port = ready ? portChip(terminals, worktree.id, (id) => id) : null
  const tests = testPane === undefined ? undefined : runState(testPane)
  const testText = tests === undefined ? undefined : TEST_CHIP[tests]
  const chips: RowChip<React.ReactNode>[] = []
  const add = (key: string, rank: ChipRank, text: string, node: React.ReactNode): void => {
    chips.push({ key, rank, text, node })
  }

  if (gitCounts || merged || badge !== null) {
    const words = [gitCounts ? git?.description : '', merged ? mergedChip(landing).label : '', badge?.detail]
    add(
      'git',
      git?.tone === 'conflict' || badge?.tone === 'conflicts' ? 'conflict' : 'rest',
      words.filter(Boolean).join(' · '),
      // One group, so the open row can hide what its status bar and Changes badge already say.
      <span className="worktree__git">
        {ready ? (
          <GitStatusChips status={status} child={worktree.parentId !== undefined} aheadBehind={!merged} />
        ) : null}
        {merged ? (
          <span className="chip worktree__merged" title={mergedChip(landing).title}>
            {mergedChip(landing).label}
          </span>
        ) : null}
        {badge?.tone === 'clean' ? (
          <span
            className="worktree__merge worktree__merge--clean"
            role="img"
            aria-label={badge.detail}
            title={badge.detail}
          >
            <Icon name="merge-clean" size={14} />
          </span>
        ) : badge?.tone === 'conflicts' ? (
          <span
            className="worktree__merge worktree__merge--conflicts"
            role="img"
            aria-label={badge.detail}
            title={badge.detail}
          >
            <Icon name="merge-conflict" size={14} />
          </span>
        ) : badge ? (
          <span className={`chip worktree__merge worktree__merge--${badge.tone}`} title={badge.detail}>
            {badge.label}
          </span>
        ) : null}
      </span>
    )
  }
  if (issue !== undefined) {
    add(
      'issue',
      'rest',
      `Issue #${issue.number}`,
      // Inside the row's button, so a span: a nested link would open the row as well.
      <span
        className="chip worktree__issue"
        role="link"
        title={issue.url}
        onClick={(event) => {
          event.stopPropagation()
          openInBrowser(issue.url)
        }}
      >
        {`#${issue.number}`}
      </span>
    )
  }
  if (pullChip !== null) {
    add(
      'pr',
      pullChip.tone === 'fail' ? 'failing' : 'rest',
      pullChip.text,
      <PullRequestMark pull={landing?.pullRequest} />
    )
  }
  if (port !== null) {
    add(
      'port',
      port.clash ? 'conflict' : 'rest',
      port.label,
      <PortChipView terminals={terminals} worktreeId={worktree.id} />
    )
  }
  if (overlap !== undefined && ready) {
    add(
      'overlap',
      overlap.chip.tone === 'conflict' ? 'conflict' : 'rest',
      `⚠ ${overlap.chip.label}`,
      <OverlapMark chip={overlap.chip} onOpen={overlap.onOpen} />
    )
  }
  if (testText !== undefined) {
    add(
      'tests',
      tests === 'failed' ? 'failing' : 'rest',
      testText,
      <RunChip terminals={terminals} worktreeId={worktree.id} />
    )
  }
  if (handoff !== null) add('handoff', 'rest', handoff, <span className="chip worktree__handoff">{handoff}</span>)
  if (onRemoveCopy !== undefined) {
    add(
      'removeCopy',
      'rest',
      'Remove My Copy',
      // Inside the row's button, so a span, as the issue chip is.
      <span
        className="chip worktree__handoff worktree__remove-copy"
        role="button"
        onClick={(event) => {
          event.stopPropagation()
          onRemoveCopy()
        }}
      >
        Remove My Copy
      </span>
    )
  }
  if (claims !== '' && ready) {
    const text = `Claims: ${claims.split('\n').join(', ')}`
    add(
      'claims',
      'rest',
      text,
      <span className="chip worktree__claims" role="img" title={claims} aria-label={text}>
        ⚑
      </span>
    )
  }
  if (task !== undefined) {
    const tally = `${task.tally.done}/${task.tally.total} done`
    add(
      'tally',
      task.rolled?.tone === 'waiting' && task.rolled.from !== undefined ? 'asking' : 'rest',
      tally,
      // Inside the row's button, so a span, as the issue chip is.
      <span
        className="chip worktree__tally"
        role="link"
        title={task.children.join('\n')}
        onClick={(event) => {
          event.stopPropagation()
          void useChildren.getState().showChildren(worktree.id)
        }}
      >
        {tally}
      </span>
    )
  }
  if (creating) add('creating', 'rest', 'creating', <span className="chip worktree__tag">creating</span>)
  if (failed)
    add('failed', 'failing', 'failed', <span className="chip worktree__tag worktree__tag--failed">failed</span>)
  if (missing) {
    add(
      'missing',
      'failing',
      'missing',
      <span className="chip worktree__tag" title={`${worktree.path} is not on disk`}>
        missing
      </span>
    )
  }

  const body = (
    <>
      {/* The small facts about the branch share the line below with the branch, so four badges
        cannot squeeze the name; with no branch to show they sit at the title line's end. */}
      {/* Hidden while it only draws: the row's name and description say it all in words. */}
      <span className="worktree__title" aria-hidden={renaming ? undefined : true}>
        {/* In the gutter before the name, so the dots make one column to scan down. */}
        {/* Nothing running still takes the gutter: a grey dot, so the names start on one line. */}
        {tone === null && ready && task === undefined ? <span className="activity" /> : null}
        {tone ? (
          <span
            className={dotClass(tone)}
            role="img"
            title={
              rolled?.from === undefined
                ? `${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${TONE_LABEL[tone]}${
                    unreadHere ? ' · unread' : ''
                  }`
                : `${TONE_LABEL[tone]} · ${rolled.from}`
            }
            aria-label={TONE_LABEL[tone]}
          />
        ) : null}
        {renaming ? (
          <WorktreeNameField name={worktree.name} onRename={onRename} onDone={() => setRenaming(false)} />
        ) : (
          <>
            {/* The one part that differs between runs of a task, so it is the part never cut. */}
            {display.agent ? (
              <span className="worktree__agent">
                {display.agent.kind === undefined ? null : <AgentGlyph kind={display.agent.kind} decorative />}
                {agentWord ? agentName(display.agent) : null}
              </span>
            ) : null}
            <span
              className={`worktree__name${unreadHere ? ' worktree__name--unread' : ''}`}
              title={[
                pullRequest === undefined ? label : `${label} · Pull Request #${pullRequest.number}`,
                `${worktree.branch} ${startedFromLabel(worktree)}`,
                ...(tokens ?? [])
              ].join('\n')}
              onDoubleClick={() => setRenaming(true)}
            >
              {display.title}
            </span>
          </>
        )}
        <span className="worktree__end">
          {/* Said in words only where no facts need the room: the dot and the edge already say it. */}
          {tone === 'waiting' && chips.length === 0 ? (
            <span className="worktree__state">{TONE_LABEL.waiting}</span>
          ) : null}
          {twoLines ? null : <FoldedChips chips={chips} most={compact ? COMPACT_CHIPS : chips.length} label={label} />}
        </span>
      </span>
      {twoLines ? (
        <span className="worktree__meta" aria-hidden="true">
          <span className="worktree__branch" title={branch}>
            {branch ?? ''}
          </span>
          {chips.map((chip) => (
            <Fragment key={chip.key}>{chip.node}</Fragment>
          ))}
        </span>
      ) : null}
    </>
  )

  return (
    <li
      ref={rowElement}
      className={`worktree${active ? ' worktree--active' : ''}${
        tone === 'waiting' ? ' worktree--asking' : ''
      } worktree--${missing ? 'missing' : worktree.state}${dragged ? ' worktree--dragging' : ''}${
        drop.target === null ? '' : drop.target.allowed ? ' worktree--drop' : ' worktree--no-drop'
      }${context ? ' worktree--context' : ''}${menuAt === null ? '' : ' worktree--menu-open'}`}
      data-worktree-id={worktree.id}
      style={depth === 0 ? undefined : ({ '--depth': depth } as React.CSSProperties)}
      role="none"
      // Read as the pointer arrives, so the name's tooltip has tokens by the time it shows.
      onMouseEnter={ready ? () => hoverUsage(worktree.id) : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        // The context-menu key and Shift+F10 raise this same event with
        // Chromium reporting a detail of 0 and no coordinates; a menu placed
        // there would open in the corner of the window.
        const pointed = event.detail > 0 && (event.clientX > 0 || event.clientY > 0)
        openMenu(
          pointed ? { x: event.clientX, y: event.clientY } : rowAnchor(),
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        )
      }}
      onKeyDown={(event) => {
        // The browser's default turns these keys into the `contextmenu` above;
        // `preventDefault` stops it arriving twice.
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        openMenu(rowAnchor(), document.activeElement instanceof HTMLElement ? document.activeElement : null)
      }}
    >
      <div
        className="worktree__row"
        draggable={draggable}
        {...drop.handlers}
        {...(draggable
          ? {
              onDragStart: (event: React.DragEvent) => {
                event.dataTransfer.setData(NEST_DRAG_TYPE, worktree.id)
                event.dataTransfer.effectAllowed = 'move'
                startNestDrag(worktree.id)
              },
              onDragEnd: endNestDrag
            }
          : {})}
      >
        {task === undefined ? null : (
          <button
            type="button"
            className="worktree__fold"
            tabIndex={-1}
            aria-label={`${task.collapsed ? 'Expand' : 'Collapse'} ${label}`}
            aria-expanded={!task.collapsed}
            onClick={() => task.onCollapse(!task.collapsed)}
          >
            <Icon name="chevron-right" size={14} className={`chevron${task.collapsed ? '' : ' chevron--open'}`} />
          </button>
        )}
        {/* A field cannot sit inside a button, so while renaming the row is a plain box. */}
        {renaming ? (
          <div className="worktree__open worktree__open--renaming">{body}</div>
        ) : (
          <button
            type="button"
            className="worktree__open"
            ref={openControl}
            role="treeitem"
            aria-level={2 + depth}
            aria-expanded={expandable ? shown : undefined}
            tabIndex={-1}
            onClick={openable ? onOpen : undefined}
            // As in Finder: Return renames, ⌘↓ opens. Space still opens, being the button's own key.
            onKeyDown={(event) => {
              const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
              if (bare && expandable && event.key === (shown ? 'ArrowLeft' : 'ArrowRight')) {
                event.preventDefault()
                show(!shown)
              }
              if (!openable) return
              if (event.key === 'Enter' && bare) {
                event.preventDefault()
                setRenaming(true)
              } else if (event.key === 'ArrowDown' && event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault()
                onOpen()
              }
            }}
            aria-disabled={openable ? undefined : true}
            aria-current={active ? 'true' : undefined}
            aria-label={label}
            aria-describedby={description === '' ? undefined : describedBy}
          >
            {body}
          </button>
        )}
        <span id={describedBy} hidden>
          {description}
        </span>
        {/* The only button on the row besides the row itself, and it opens the
            same menu the right button does. Named for what it opens rather than
            for what it looks like: "More" is what a `⋯` is called by anybody
            who cannot see it. */}
        <button
          type="button"
          className="worktree__action"
          tabIndex={-1}
          title={`More for ${label}`}
          aria-label={`More for ${label}`}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            openMenu({ x: rect.right - 8, y: rect.bottom + 2 }, event.currentTarget)
          }}
        >
          <Icon name="more" size={14} />
        </button>
      </div>

      {drop.target === null ? null : (
        <DropHint text={drop.target.allowed ? drop.target.hint : drop.target.reason} refused={!drop.target.allowed} />
      )}

      {ask === undefined || (compact && liveAsk === undefined) ? null : (
        <AskForYou key={ask.id} ask={ask} compact={compact} />
      )}
      {report === null || compact ? null : <p className="worktree__line worktree__report">{report}</p>}
      {heard === undefined || heardFrom === undefined || compact ? null : (
        <p className="worktree__line worktree__report" title={heard.text}>
          {`${heard.outcome === 'failed' ? '✗' : '✓'} ${heardFrom.name}: ${firstSentence(heard.text)}`}
        </p>
      )}

      {menuAt === null ? null : (
        <RowMenu label={`Actions for ${label}`} items={items} anchor={menuAt} onClose={closeMenu} />
      )}

      {rows.length > 0 && shown && !compact && !saidAbove ? (
        <PaneRows
          tree
          level={3 + depth}
          rows={rows}
          worktreeName={display.title}
          watchers={watchers}
          unread={unread}
          now={now}
          onFocusTerminal={onFocusTerminal}
          answerChip={answerChip}
        />
      ) : null}

      {creating ? (
        <div className="worktree__progress" role="progressbar" aria-label={`Creating ${label}`}>
          <span className="worktree__progress-bar" />
        </div>
      ) : null}

      {failed && !compact ? (
        <div className="worktree__failure">
          <p className="worktree__error" title={worktree.error}>
            {failureLine(worktree.error)}
          </p>
          {worktree.retryable ? (
            <button type="button" className="button button--ghost button--tiny" tabIndex={-1} onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <button type="button" className="button button--ghost button--tiny" tabIndex={-1} onClick={onRemove}>
            Remove
          </button>
        </div>
      ) : null}
    </li>
  )
}

/** What a drop target says while a row is over it: why not, or what the move will also do. */
export function DropHint({ text, refused }: { text: string | null; refused: boolean }): React.JSX.Element | null {
  if (text === null) return null
  return <span className={`drop-hint${refused ? ' drop-hint--refused' : ''}`}>{text}</span>
}

/** A finished task's own word on how it went: `msg done`'s first sentence. */
function reportLine(worktree: Worktree): string | null {
  const report = worktree.report
  if (report === undefined) return null
  return `${report.outcome === 'failed' ? '✗' : '✓'} ${firstSentence(report.summary)}`
}

const FAILURE_LINE_MAX = 60

/** git's own words from a failure, on one line of at most sixty characters. */
function failureLine(error: string | undefined): string {
  if (!error) return 'Creation failed'
  // A failed git command reads `git <args> exited with code N: <stderr>`; the stderr is the reason.
  const reason = error.replace(/^git .*? (?:exited with code \S+|timed out|cancelled): /s, '')
  const line = (reason.split('\n').find((part) => part.trim()) ?? reason).trim().replace(/^(?:fatal|error): /i, '')
  const sentence = line.charAt(0).toUpperCase() + line.slice(1)
  return sentence.length <= FAILURE_LINE_MAX ? sentence : `${sentence.slice(0, FAILURE_LINE_MAX - 1).trimEnd()}…`
}
