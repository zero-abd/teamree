// Renders a PaneNode tree as nested flex rows and columns. Every split owns
// the gutters between its own children, so nesting is unbounded and a drag
// only ever touches the two panes either side of the handle it grabbed. Each
// leaf is a group: its own strip of tabs over its shown tab, the rest kept mounted.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { PaneNode, Terminal } from '@shared/entities'
import { fileColumnIn, fileTabName, isFileColumn, isFileLeaf, type FileLeaf as FileLeafNode } from '@shared/filePane'
import { minExtent, type Box } from '@shared/paneRoom'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { paneNamesById } from '../sidebar/agentRows'
import type { WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { scrollShownPane } from '../terminal/shownPanes'
import { requestRegionFocus } from '../shell/regions'
import { TerminalView } from '../terminal/TerminalView'
import { usePaneMenu } from '../workspace/paneMenu'
import { GroupStrip } from '../workspace/TerminalTabs'
import { FilePane } from './FilePane'
import {
  PaneAsk,
  PaneEndBlock,
  PaneFoot,
  PaneStarting,
  paneStage,
  primaryIsFresh,
  SetupMissingTool,
  useSeenOutput
} from './PaneLifecycle'
import { groupTabs, shownOf, type PaneGroup } from './paneGroups'
import { normalizeSizes } from './paneLayout'
import { SplitFrame } from './SplitFrame'

export type PaneCallbacks = {
  terminals: Record<string, Terminal>
  /** The worktree a file pane's file is read from. */
  worktreeId: string
  /** What names that worktree; its agent pane goes by its title, as on the tab. */
  worktree?: WorktreeNameSource
  /** Each pane's name by id, the tab strip's names, worked out once at the root; callers leave it out. */
  names?: Readonly<Record<string, string>>
  focusedTerminalId: string | null
  onFocus: (terminalId: string) => void
  onClose: (terminalId: string) => void
  /** Runs an exited pane's program again, in the same pane; an agent resumes unless `fresh`. */
  onRelaunch: (terminalId: string, options?: { fresh?: boolean }) => void
  /** Picks a conversation for an ended agent pane to resume in place; absent leaves the button out. */
  onResumeConversation?: (terminalId: string) => void
  onResize: (path: number[], sizes: number[]) => void
  isAppChord: (event: KeyboardEvent) => boolean
  /** Spells the chords in the header's right-click menu. */
  modifier: PlatformModifier
  /** The one pane showing the find bar, if any. */
  searchTerminalId: string | null
  searchToken: number
  onCloseSearch: () => void
  /** The least a pane may be dragged to, chrome included; unmeasured, a small fraction stands. */
  minPane?: Box
  /** The file column folded for room: drawn nowhere, its share lent to its siblings. */
  foldedColumn?: PaneNode | null
}

export function PaneTree({
  node,
  path,
  ...callbacks
}: PaneCallbacks & { node: PaneNode; path: number[] }): React.JSX.Element {
  const names = callbacks.names ?? namesById(callbacks.worktreeId, callbacks.terminals, callbacks.worktree)
  const tree =
    node.kind === 'leaf' || isFileColumn(node) ? (
      <PaneGroupView group={node} {...callbacks} names={names} />
    ) : (
      <PaneSplit node={node} path={path} {...callbacks} names={names} />
    )
  return path.length === 0 ? <GroupBirths>{tree}</GroupBirths> : tree
}

/** The keys of the groups drawn so far in this tree, and whether its first frame is past: a group new after it fades in. */
const Births = createContext<{ seen: Set<string>; settled: { current: boolean } } | null>(null)

function GroupBirths({ children }: { children: React.ReactNode }): React.JSX.Element {
  const value = useRef({ seen: new Set<string>(), settled: { current: false } }).current
  useEffect(() => {
    value.settled.current = true
  }, [value])
  return <Births.Provider value={value}>{children}</Births.Provider>
}

/** A group: its strip over its tabs, every tab kept mounted and only the shown one drawn. */
function PaneGroupView({ group, ...callbacks }: PaneCallbacks & { group: PaneGroup }): React.JSX.Element {
  const tabs = groupTabs(group)
  const shown = shownOf(group)
  const births = useContext(Births)
  const key = groupKey(group)
  const born = useRef(births !== null && births.settled.current && !births.seen.has(key)).current
  births?.seen.add(key)
  const active = tabs.some((tab) => tab.terminalId === callbacks.focusedTerminalId)
  return (
    <div
      className={`group${active ? ' group--active' : ''}${born ? ' group--born' : ''}`}
      data-group={shown}
      data-tabs={tabs.length}
    >
      <GroupStrip
        group={group}
        terminals={callbacks.terminals}
        worktree={callbacks.worktree}
        active={active}
        modifier={callbacks.modifier}
        onFocus={callbacks.onFocus}
        onClose={callbacks.onClose}
      />
      <div className="group__body">
        {tabs.map((tab) => (
          <div key={tab.terminalId} className="group__page" hidden={tab.terminalId !== shown}>
            {isFileLeaf(tab) ? (
              <FileLeaf leaf={tab} {...callbacks} />
            ) : (
              <PaneLeaf terminalId={tab.terminalId} {...callbacks} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function FileLeaf({
  leaf,
  worktreeId,
  focusedTerminalId,
  onFocus,
  onClose,
  searchTerminalId,
  searchToken,
  onCloseSearch,
  modifier
}: PaneCallbacks & { leaf: FileLeafNode }): React.JSX.Element {
  const menu = usePaneMenu(modifier)
  const paneId = leaf.terminalId
  const name = fileTabName(leaf)
  return (
    <>
      <FilePane
        paneId={paneId}
        worktreeId={worktreeId}
        path={leaf.path}
        {...(leaf.commit === undefined ? {} : { commit: leaf.commit })}
        {...(leaf.compare === undefined ? {} : { compare: leaf.compare })}
        {...(leaf.review === true ? { review: true } : {})}
        {...(leaf.sharedNote === undefined ? {} : { sharedNote: leaf.sharedNote })}
        focused={focusedTerminalId === paneId}
        onFocus={() => onFocus(paneId)}
        onClose={() => onClose(paneId)}
        tabbed
        onHeaderMenu={(event) => menu.onContextMenu(paneId, name, event)}
        onMenu={(event) => menu.onButton(paneId, name, event)}
        searchToken={searchTerminalId === paneId ? searchToken : 0}
        onCloseSearch={onCloseSearch}
      />
      {menu.menu}
    </>
  )
}

/** The worktree's panes named in the order they were opened, as `paneTabs` and the sidebar name them. */
function namesById(
  worktreeId: string,
  terminals: Readonly<Record<string, Terminal>>,
  worktree: WorktreeNameSource | undefined
): Record<string, string> {
  return paneNamesById(
    Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId),
    worktree
  )
}

function PaneLeaf({
  terminalId,
  terminals,
  names,
  focusedTerminalId,
  onFocus,
  onClose,
  onRelaunch,
  onResumeConversation,
  isAppChord,
  searchTerminalId,
  searchToken,
  onCloseSearch,
  modifier
}: PaneCallbacks & { terminalId: string }): React.JSX.Element {
  const menu = usePaneMenu(modifier)
  const terminal = terminals[terminalId]
  const focused = focusedTerminalId === terminalId
  const seen = useSeenOutput(terminal)
  const stage = terminal === undefined ? null : paneStage(terminal, seen)
  const ended = stage === 'ended' || stage === 'failed' || stage === 'restored'
  // One name per pane, shared by strip, region, menu and close question.
  const name = names?.[terminalId] ?? terminal?.title ?? 'terminal'
  const primary = (): void => {
    if (terminal !== undefined && ended && primaryIsFresh(terminal, stage)) onRelaunch(terminalId, { fresh: true })
    else onRelaunch(terminalId)
  }

  return (
    <section
      className={`pane pane--terminal${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onKeyDownCapture={ended ? (event) => endedKeys(event, primary) : undefined}
    >
      {stage === 'asking' && terminal !== undefined ? (
        <PaneAsk
          terminal={terminal}
          onReview={() => {
            // Already focused, a focus call alone did nothing: bring the question at the bottom into view.
            onFocus(terminalId)
            scrollShownPane(terminalId)
            requestRegionFocus('panes')
          }}
        />
      ) : null}
      {stage === 'starting' && terminal !== undefined ? <PaneStarting terminal={terminal} /> : null}
      {stage === null && terminal?.label === 'setup' ? <SetupMissingTool terminal={terminal} /> : null}
      <TerminalView
        terminalId={terminalId}
        focused={focused}
        onFocus={() => onFocus(terminalId)}
        isAppChord={isAppChord}
        searchOpen={searchTerminalId === terminalId}
        searchToken={searchToken}
        onCloseSearch={onCloseSearch}
      />
      {terminal !== undefined && stage !== null && !ended ? <PaneFoot terminal={terminal} stage={stage} /> : null}
      {terminal !== undefined && ended ? (
        <PaneEndBlock
          terminal={terminal}
          name={name}
          stage={stage}
          actions={{
            onRelaunch: (options) => (options === undefined ? onRelaunch(terminalId) : onRelaunch(terminalId, options)),
            ...(onResumeConversation === undefined
              ? {}
              : { onResumeConversation: () => onResumeConversation(terminalId) }),
            onClose: () => onClose(terminalId),
            onContextMenu: (event) => menu.onContextMenu(terminalId, name, event)
          }}
        />
      ) : null}
      {menu.menu}
    </section>
  )
}

/** In a dead pane's terminal, Enter takes the end block's first action and Tab goes to it; buttons keep theirs. */
function endedKeys(event: React.KeyboardEvent<HTMLElement>, primary: () => void): void {
  if ((event.target as HTMLElement).closest('.xterm') === null) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    primary()
  } else if (event.key === 'Tab' && !event.shiftKey) {
    const first = event.currentTarget.querySelector<HTMLButtonElement>('.pane-end button')
    if (first === null) return
    event.preventDefault()
    event.stopPropagation()
    first.focus()
  }
}

function PaneSplit({
  node,
  path,
  onResize,
  ...callbacks
}: PaneCallbacks & { node: Extract<PaneNode, { kind: 'split' }>; path: number[] }): React.JSX.Element {
  const { minPane, foldedColumn = null } = callbacks
  // Indices into the whole split, so a resize addresses the tree the runtime holds.
  const drawn = node.children.flatMap((child, index) => (child === foldedColumn ? [] : [{ child, index }]))

  const sizes = normalizeSizes(node.sizes, node.children.length)
  const lent = 1 - drawn.reduce((sum, { index }) => sum + (sizes[index] ?? 0), 0)
  return (
    <SplitFrame
      direction={node.direction}
      sizes={drawn.map(({ index }) => sizes[index] ?? 0)}
      onResize={(next) => {
        const whole = [...sizes]
        drawn.forEach(({ index }, at) => (whole[index] = (next[at] ?? 0) * (1 - lent)))
        onResize(path, whole)
      }}
      minPx={minPane && drawn.map(({ child }) => minExtent(child, node.direction, minPane))}
      cells={drawn.map(({ child, index }) => ({
        key: paneKey(child, index),
        node: <PaneTree node={child} path={[...path, index]} onResize={onResize} {...callbacks} />
      }))}
    />
  )
}

/** Keys follow the terminals, so resizing never remounts (and reloads) a pane, nor a tab added to its group. */
function paneKey(node: PaneNode, index: number): string {
  return node.kind === 'leaf' || isFileColumn(node) ? groupKey(node) : `split:${index}:${firstTerminalId(node)}`
}

/** A group by its first tab; the file column by name, or closing its first tab would remount every editor in it. */
function groupKey(group: PaneGroup): string {
  if (group.kind === 'leaf') return group.terminalId
  return fileColumnIn(group) === group ? 'file-column' : firstTerminalId(group)
}

function firstTerminalId(node: PaneNode): string {
  if (node.kind === 'leaf') return node.terminalId
  const first = node.children[0]
  return first ? firstTerminalId(first) : 'empty'
}
