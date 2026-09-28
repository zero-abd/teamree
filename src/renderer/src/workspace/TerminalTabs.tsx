// The workspace's head and its strips of tabs. The head is the window's top edge on this side: the worktree's
// name, and the runs, maximize and splits, which act on the worktree and the focused pane. Each group of tabs
// under it has its own strip, directly above its pane: its tabs, `+N` for any out of sight, and `+`.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hasCheckout, type Terminal } from '@shared/entities'
import { UnsavedDot } from '../files/FileBar'
import { usePaneDrag, useTabDrag } from '../panes/paneDrag'
import { shownOf, type PaneGroup } from '../panes/paneGroups'
import { collectTerminalIds } from '../panes/paneLayout'
import { resumableAgents } from '../panes/resumeAll'
import { usePaneMenu } from './paneMenu'
import { paneTabs, paneTabTitle, type PaneTab } from './paneTabs'
import { RunButtons } from './runButtons'
import { useStartMenuItems } from './startMenu'
import { PaneGlyph } from '../agents/glyphs'
import { Icon } from '../icons/Icon'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { dotClass, dotTone } from '../sidebar/agentRows'
import { paneMarkTip } from '../sidebar/tipText'
import { worktreeDisplay, type WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { refocus, RowMenu, type MenuClosed, type RowMenuAnchor } from '../sidebar/RowMenu'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Between a button and the menu that hangs from it. */
const MENU_GAP_PX = 4

/** Within the 120–180 ms the rest of the chrome moves in. */
const TAB_MOTION_MS = 150

/** Over the panes, the worktree's name and its buttons; over a page with the sidebar away, only Show sidebar. */
export function WorkspaceHead({ modifier }: { modifier: PlatformModifier }): React.JSX.Element | null {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === worktree?.projectId))
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  // Same precedence `WorkspaceArea` applies.
  const panesShown = useWorkspaceStore(
    (state) => !state.dashboardOpen && state.teamworkProjectId === null && !state.settingsOpen && !state.helpOpen
  )
  // Settings hides the sidebar itself (see App), so there is no Show sidebar to hold over it.
  const settingsShown = useWorkspaceStore(
    (state) => state.settingsOpen && !state.dashboardOpen && state.teamworkProjectId === null
  )

  // A page's own head is the top edge while it is open.
  if (!panesShown && (sidebarVisible || settingsShown)) return null
  const display = worktree === undefined ? undefined : worktreeDisplay(worktree)

  return (
    <div
      className={display === undefined ? 'workspace__head workspace__head--bare' : 'workspace__head'}
      data-region="strip"
    >
      <SidebarToggle />
      {display === undefined || !panesShown ? null : (
        <>
          <span className="workspace__name">{display.title}</span>
          <span className="workspace__where">
            {[project?.name, worktree?.branch].filter((part) => part !== undefined && part !== '').join(' · ')}
          </span>
        </>
      )}
      {worktreeId === null || !panesShown ? null : <HeadActions worktreeId={worktreeId} modifier={modifier} />}
    </div>
  )
}

/** Show sidebar, first in the strip so that on macOS it comes right after the window buttons. */
function SidebarToggle(): React.JSX.Element | null {
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  return sidebarVisible ? null : (
    <button
      type="button"
      className="shell__toggle"
      data-tip="Show sidebar"
      aria-label="Show sidebar"
      onClick={toggleSidebar}
    >
      <Icon name="sidebar-toggle" />
    </button>
  )
}

/** One group's strip: its tabs, `+N` for any out of sight, and `+` for a new tab here. */
export function GroupStrip({
  group,
  terminals,
  worktree,
  active,
  modifier,
  onFocus,
  onClose
}: {
  group: PaneGroup
  terminals: Readonly<Record<string, Terminal>>
  /** What names the worktree; its agent pane goes by its title. */
  worktree: WorktreeNameSource | undefined
  /** It holds the focused pane. */
  active: boolean
  modifier: PlatformModifier
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
}): React.JSX.Element {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const renamePane = useWorkspaceStore((state) => state.renamePane)
  const pinFilePane = useWorkspaceStore((state) => state.pinFilePane)
  const unsavedFiles = useWorkspaceStore((state) => state.unsavedFiles)
  const namingMarkdown = useWorkspaceStore((state) => state.namingMarkdown)
  const nameMarkdown = useWorkspaceStore((state) => state.nameMarkdown)
  const renaming = useWorkspaceStore((state) => state.editingPaneName)
  const setRenaming = useWorkspaceStore((state) => state.editPaneName)
  const paneMenu = usePaneMenu(modifier)
  const startDrag = useTabDrag()
  const dragged = usePaneDrag((state) => state.drag?.source.id)
  // The sidebar's reading, so the strip and the row agree.
  const unread = useUnreadPanes()

  const tabs = paneTabs(group, terminals, worktree)
  const shown = shownOf(group)

  const list = useRef<HTMLDivElement | null>(null)
  const [outside, setOutside] = useState(0)
  const [listing, setListing] = useState<{ anchor: RowMenuAnchor; opener: HTMLElement } | null>(null)
  const count = useCallback(() => setOutside(cutTabsOutOfView(list.current)), [])
  const ids = tabs.map((tab) => tab.terminalId).join(' ')

  // However a tab comes to be shown (a click, a chord, a link), it is scrolled into sight, and kept there as
  // the strip or the tab changes width.
  useLayoutEffect(() => {
    const element = list.current
    if (element === null) return
    const reveal = (): void => {
      const tab = element.querySelector<HTMLElement>(':scope > .tab--active')
      if (tab) bringIntoView(element, tab)
      count()
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    return () => observer.disconnect()
  }, [shown, ids, count])
  useTabMotion(list, ids)

  const closeListing = (): void => {
    listing?.opener.focus()
    setListing(null)
  }
  const naming = active && namingMarkdown !== null && namingMarkdown === worktreeId

  return (
    <div className={`tabs${active ? ' tabs--active' : ''}`} data-region="strip">
      <div
        ref={list}
        className="tabs__list"
        role="tablist"
        aria-label="Tabs"
        onScroll={count}
        onWheel={(event) => {
          // A mouse wheel only scrolls vertically, and the list has no vertical to scroll.
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.terminalId}
            tab={tab}
            shown={tab.terminalId === shown}
            unread={unread.has(tab.terminalId)}
            unsaved={unsavedFiles[tab.terminalId] === true}
            dragged={dragged === tab.terminalId}
            renaming={renaming === tab.terminalId}
            onPress={(event) => startDrag(event, { id: tab.terminalId, label: tab.label })}
            onMenu={(event) => paneMenu.onContextMenu(tab.terminalId, tab.label, event)}
            onKey={(event) => paneMenu.onKeyDown(tab.terminalId, tab.label, event)}
            onFocus={() => onFocus(tab.terminalId)}
            onPin={() => pinFilePane(tab.terminalId)}
            onRename={() => setRenaming(tab.terminalId)}
            onRenamed={(name) => {
              setRenaming(null)
              // Enter on the untouched field is not a rename: storing `claude 1` would freeze a made-up number.
              if (name.trim() !== tab.label) void renamePane(tab.terminalId, name)
            }}
            onCancelRename={() => setRenaming(null)}
            onClose={() => onClose(tab.terminalId)}
          />
        ))}
        {/* NOTES.md is already open: the next file's name, asked where the focus is. */}
        {naming ? (
          <div className="tab">
            <RenameField
              name=""
              label="File name"
              placeholder="name.md"
              onCommit={(name) => nameMarkdown(name)}
              onCancel={() => nameMarkdown(null)}
            />
          </div>
        ) : null}
      </div>
      {outside === 0 ? null : (
        <button
          type="button"
          className="tabs__more"
          aria-label="All tabs"
          aria-haspopup="menu"
          aria-expanded={listing !== null}
          onClick={(event) => {
            if (listing !== null) return closeListing()
            const box = event.currentTarget.getBoundingClientRect()
            setListing({
              anchor: { x: box.right, y: box.bottom + MENU_GAP_PX, align: 'right' },
              opener: event.currentTarget
            })
          }}
        >
          +{outside}
        </button>
      )}
      {listing === null ? null : (
        <RowMenu
          label="All tabs"
          anchor={listing.anchor}
          opener={listing.opener}
          onClose={closeListing}
          items={tabs.map((tab) => ({
            label: tab.label,
            icon: <span className="tabs__mark">{unsavedFiles[tab.terminalId] ? <UnsavedDot /> : null}</span>,
            current: tab.terminalId === shown,
            onChoose: () => onFocus(tab.terminalId)
          }))}
        />
      )}
      {worktreeId === null ? null : <NewTab worktreeId={worktreeId} group={shown} modifier={modifier} />}
      {paneMenu.menu}
    </div>
  )
}

type TabProps = {
  tab: PaneTab
  shown: boolean
  unread: boolean
  unsaved: boolean
  dragged: boolean
  renaming: boolean
  onPress: (event: React.PointerEvent<HTMLElement>) => void
  onMenu: (event: React.MouseEvent<HTMLElement>) => void
  onKey: (event: React.KeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onPin: () => void
  onRename: () => void
  onRenamed: (name: string) => void
  onCancelRename: () => void
  onClose: () => void
}

function Tab({ tab, shown, unread, unsaved, dragged, renaming, ...on }: TabProps): React.JSX.Element {
  const isFile = tab.kind === 'file'
  const tone = tab.activity === null ? null : dotTone(tab.activity, tab.agent)
  return (
    <div
      className={`tab${shown ? ' tab--active' : ''}${unread ? ' tab--unread' : ''}${dragged ? ' tab--dragged' : ''}`}
      data-pane-id={tab.terminalId}
      onPointerDown={(event) => {
        if (!renaming) on.onPress(event)
      }}
      onContextMenu={(event) => {
        if (!renaming) on.onMenu(event)
      }}
    >
      {renaming ? (
        // The shown name, not the stored label, which is empty for app-named panes.
        <RenameField name={tab.label} onCommit={on.onRenamed} onCancel={on.onCancelRename} />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={shown}
          aria-label={tab.label}
          className="tab__main"
          data-tip={unsaved ? `${tab.label} · unsaved` : unread ? `${paneTabTitle(tab)} · unread` : paneTabTitle(tab)}
          onClick={on.onFocus}
          onKeyDown={on.onKey}
          onDoubleClick={() => {
            if (!isFile) on.onRename()
            else if (tab.preview) on.onPin()
          }}
        >
          {/* The sidebar's dot, borrowed rather than reinvented: the same reading of the same PTY. */}
          {isFile ? (
            <Icon name="file" size={14} className="file__glyph" />
          ) : (
            <span className={dotClass(tone)} aria-hidden="true" data-tip={paneMarkTip(tab.agent, tone)} />
          )}
          {isFile ? null : <PaneGlyph agent={tab.agent} tip={paneMarkTip(tab.agent, tone)} />}
          {tab.text === '' ? null : (
            <span className={`tab__name${tab.preview ? ' tab__name--preview' : ''}`}>{tab.text}</span>
          )}
          {unsaved ? <UnsavedDot /> : null}
        </button>
      )}
      {/* A button besides double-click: F2 is a brightness key on a Mac keyboard. A file pane is named by its file. */}
      {isFile ? null : (
        <button
          type="button"
          className="tab__rename"
          data-tip={`Rename pane ${tab.label}`}
          aria-label={`Rename pane ${tab.label}`}
          onClick={on.onRename}
        >
          <Icon name="rename" size={14} />
        </button>
      )}
      {/* The pane's own close: it kills the process, since a hidden-but-running pane has no leaf. */}
      <button
        type="button"
        className="tab__close"
        data-tip={`Close pane ${tab.label}`}
        aria-label={`Close pane ${tab.label}`}
        onClick={on.onClose}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

/** Resume All, when more than one of the worktree's ended agents can pick its conversation back up. */
function ResumeAll({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  // Joined, so a store change that leaves the set alone does not render the head again.
  const joined = useWorkspaceStore((state) =>
    resumableAgents(Object.values(state.terminals), worktreeId)
      .map((terminal) => terminal.id)
      .join(' ')
  )
  const ids = joined === '' ? [] : joined.split(' ')
  const resumeAgents = useWorkspaceStore((state) => state.resumeAgents)
  if (ids.length < 2) return null
  return (
    <div className="run-buttons">
      <button
        type="button"
        className="run-buttons__run"
        data-tip={`Resume ${ids.length} agents`}
        onClick={() => void resumeAgents(ids)}
      >
        <Icon name="history" size={14} />
        Resume All
      </button>
    </div>
  )
}

/** The runs, maximize and the splits, pinned to the head's end; with no panes yet, `+` too. */
function HeadActions({ worktreeId, modifier }: { worktreeId: string; modifier: PlatformModifier }): React.JSX.Element {
  // Refused only for a worktree known to have no checkout yet.
  const noCheckout = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId)
    return worktree !== undefined && !hasCheckout(worktree)
  })
  const root = useWorkspaceStore((state) => state.layouts[worktreeId]?.root ?? null)
  const expanded = useWorkspaceStore((state) => state.expandedTerminalId)
  const splitFocusedPane = useWorkspaceStore((state) => state.splitFocusedPane)
  const toggleExpandedPane = useWorkspaceStore((state) => state.toggleExpandedPane)
  const empty = root === null

  return (
    <div className="tabs__actions">
      <ResumeAll worktreeId={worktreeId} />
      {noCheckout ? null : <RunButtons worktreeId={worktreeId} />}
      <div className="tabs__layout">
        <button
          type="button"
          className="tabs__action"
          data-tip={expanded === null ? 'Maximize' : 'Restore'}
          aria-label={expanded === null ? 'Maximize' : 'Restore'}
          disabled={expanded === null && collectTerminalIds(root).length < 2}
          onClick={toggleExpandedPane}
        >
          <Icon name={expanded === null ? 'maximize' : 'restore'} />
        </button>
        <button
          type="button"
          className="tabs__action"
          data-tip="Split right"
          aria-label="Split right"
          disabled={empty}
          onClick={() => void splitFocusedPane('row')}
        >
          <Icon name="split-right" />
        </button>
        <button
          type="button"
          className="tabs__action"
          data-tip="Split down"
          aria-label="Split down"
          disabled={empty}
          onClick={() => void splitFocusedPane('column')}
        >
          <Icon name="split-down" />
        </button>
        {empty ? <NewTab worktreeId={worktreeId} group={null} modifier={modifier} /> : null}
      </div>
    </div>
  )
}

/** `+` and the menu of what can start: a tab of `group`, or a pane where there is room without one. */
function NewTab({
  worktreeId,
  group,
  modifier
}: {
  worktreeId: string
  group: string | null
  modifier: PlatformModifier
}): React.JSX.Element {
  const noCheckout = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId)
    return worktree !== undefined && !hasCheckout(worktree)
  })
  const loadConversations = useWorkspaceStore((state) => state.loadConversations)
  const startItems = useStartMenuItems(worktreeId, modifier, false, group ?? undefined)
  const plus = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  // Back on the `+`, so a keyboard user who opened the menu is where they were.
  const closeMenu = useCallback((closed?: MenuClosed): void => {
    setMenuAt(null)
    refocus(plus.current, closed)
  }, [])

  return (
    <>
      <button
        ref={plus}
        type="button"
        className="tabs__action tabs__new"
        data-tip="New tab"
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        disabled={noCheckout}
        onClick={() => {
          if (menuAt !== null) {
            closeMenu()
            return
          }
          void loadConversations(worktreeId)
          const rect = plus.current?.getBoundingClientRect()
          if (rect) setMenuAt({ x: rect.right, y: rect.bottom + MENU_GAP_PX, align: 'right' })
        }}
      >
        <Icon name="plus" />
      </button>
      {menuAt === null ? null : (
        <RowMenu label="New tab" anchor={menuAt} opener={plus.current} onClose={closeMenu} items={startItems} />
      )}
    </>
  )
}

/** Tabs slide to their new places when the order changes, and a tab that arrives fades in; not with reduced motion. */
function useTabMotion(list: React.RefObject<HTMLDivElement | null>, ids: string): void {
  const places = useRef<Map<string, number> | null>(null)
  useLayoutEffect(() => {
    const element = list.current
    if (element === null) return
    const before = places.current
    const after = new Map<string, number>()
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const tab of element.querySelectorAll<HTMLElement>(':scope > .tab[data-pane-id]')) {
      const id = tab.dataset.paneId ?? ''
      after.set(id, tab.offsetLeft)
      const was = before?.get(id)
      if (before === null || still || typeof tab.animate !== 'function') continue
      const frames =
        was === undefined
          ? [
              { opacity: 0, transform: 'translateY(3px)' },
              { opacity: 1, transform: 'none' }
            ]
          : was === tab.offsetLeft
            ? null
            : [{ transform: `translateX(${was - tab.offsetLeft}px)` }, { transform: 'none' }]
      if (frames) tab.animate(frames, { duration: TAB_MOTION_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
    }
    places.current = after
  }, [list, ids])
}

/** Scrolls the strip the least that shows all of `tab`, to a tab's left edge so the strip starts on a whole one. */
function bringIntoView(strip: HTMLElement, tab: HTMLElement): void {
  const end = tab.offsetLeft + tab.offsetWidth
  if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft
  else if (end > strip.scrollLeft + strip.clientWidth) {
    const least = end - strip.clientWidth
    const edge = [...strip.querySelectorAll<HTMLElement>(':scope > .tab')].find((each) => each.offsetLeft >= least)
    strip.scrollLeft = Math.min(edge?.offsetLeft ?? least, tab.offsetLeft)
  }
}

/** Marks `data-cut` on every tab not wholly in sight, so no half name shows, and counts them; never the shown tab. */
export function cutTabsOutOfView(strip: HTMLElement | null): number {
  if (strip === null) return 0
  const fits = strip.scrollWidth <= strip.clientWidth
  const from = strip.scrollLeft
  const to = from + strip.clientWidth
  let cut = 0
  for (const tab of strip.querySelectorAll<HTMLElement>(':scope > .tab[data-pane-id]')) {
    // Wider than the whole strip, it is still the one tab worth showing: clipped beats a bare `+N`.
    const outside =
      !fits &&
      !tab.classList.contains('tab--active') &&
      (tab.offsetLeft < from || tab.offsetLeft + tab.offsetWidth > to)
    tab.toggleAttribute('data-cut', outside)
    if (outside) cut += 1
  }
  return cut
}

/** The rename field; blur commits like Enter, and Escape sets the flag the following blur reads. */
function RenameField({
  name,
  label = 'Pane name',
  placeholder = 'Pane name',
  onCommit,
  onCancel
}: {
  name: string
  label?: string
  placeholder?: string
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const cancelled = useRef(false)
  const fieldRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.select()
  }, [])

  return (
    <input
      ref={fieldRef}
      className="tab__rename-field"
      type="text"
      spellCheck={false}
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(draft)
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        cancelled.current = true
        onCancel()
      }}
      onBlur={() => {
        if (cancelled.current) return
        onCommit(draft)
      }}
    />
  )
}
