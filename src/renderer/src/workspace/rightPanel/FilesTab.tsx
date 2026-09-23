// The worktree's files one directory at a time, plus find by name. Clicking opens a file pane; the
// row menu still offers the editor. The tree adds the changes tab's letters and git's ignored dimming.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Worktree, WorktreeFileMatches } from '@shared/entities'
import { runtimeClient } from '../../runtimeClient/currentRuntimeClient'
import { editorLabel } from '../../sidebar/Sidebar'
import { RowMenu, type RowMenuAnchor } from '../../sidebar/RowMenu'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { KIND_LETTER } from './changeKinds'
import { directoryOf, fileNameOf } from './ChangesTab'
import {
  applyListing,
  beginListing,
  changesUnder,
  emptyTree,
  expandDir,
  expandedDirs,
  failListing,
  foldDir,
  ROOT,
  statusKindFor,
  treeRows,
  type TreeRow,
  type TreeState
} from './fileTree'

/** How long the find field waits after a keystroke before asking. */
const FIND_DEBOUNCE_MS = 120

/** The most matches the field asks for; the runtime caps it too. */
const FIND_LIMIT = 200

export function FilesTab({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const changes = useWorkspaceStore((state) => state.changes[worktree.id])
  const editorCommand = useWorkspaceStore((state) => state.editorCommands[worktree.projectId])
  const editors = useWorkspaceStore((state) => state.editors)
  const openInEditor = useWorkspaceStore((state) => state.openInEditor)
  const openFilePane = useWorkspaceStore((state) => state.openFilePane)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)

  const [tree, setTree] = useState<TreeState>(emptyTree)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<WorktreeFileMatches | null>(null)
  const [menu, setMenu] = useState<{ path: string; at: RowMenuAnchor } | null>(null)
  // Answers for a worktree this tab has left are dropped.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const readDir = useCallback(
    async (path: string): Promise<void> => {
      setTree((current) => beginListing(current, path))
      try {
        const listing = await runtimeClient.call('worktree.files', {
          worktreeId: worktree.id,
          ...(path === ROOT ? {} : { path })
        })
        if (alive.current) setTree((current) => applyListing(current, listing))
      } catch (error) {
        if (alive.current) setTree((current) => failListing(current, path, reasonOf(error)))
      }
    },
    [worktree.id]
  )

  useEffect(() => {
    void readDir(ROOT)
  }, [readDir])

  // Find asks the runtime: the tree holds only what has been opened.
  useEffect(() => {
    const wanted = query.trim()
    if (wanted === '') {
      setFound(null)
      return
    }
    const timer = setTimeout(() => {
      void runtimeClient
        .call('worktree.findFiles', { worktreeId: worktree.id, query: wanted, limit: FIND_LIMIT })
        .then((matches) => {
          if (alive.current) setFound(matches)
        })
        .catch(() => {
          if (alive.current)
            setFound({ worktreeId: worktree.id, query: wanted, paths: [], truncated: false, readAt: 0 })
        })
    }, FIND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, worktree.id])

  const absolute = (path: string): string => `${worktree.path}/${path}`
  const open = (path: string): void => openFilePane(worktree.id, path)
  const openInTheEditor = (path: string): void => void openInEditor(absolute(path), editorCommand, path)
  const reveal = (path: string): void => void revealInFinder(absolute(path), path)

  const toggle = (row: TreeRow): void => {
    if (row.kind !== 'dir') {
      open(row.path)
      return
    }
    if (row.expanded) {
      setTree((current) => foldDir(current, row.path))
      return
    }
    setTree((current) => expandDir(current, row.path).tree)
    void readDir(row.path)
  }

  const reload = (): void => {
    for (const path of expandedDirs(tree)) void readDir(path)
  }

  const root = tree.dirs[ROOT]
  const rows = treeRows(tree)
  const label = editorLabel(editorCommand, editors)

  return (
    <section className="tree" aria-label="Files in this worktree">
      <div className="panel__toolbar">
        <input
          className="tree__find"
          type="search"
          value={query}
          placeholder="Find files"
          aria-label="Find files"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault()
              setQuery('')
            }
          }}
        />
        <button type="button" className="panel__tool" aria-label="Reload" title="Reload" onClick={reload}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M10 6 A4 4 0 1 1 8.6 3 M8.6 1 V3.2 H6.4" />
          </svg>
        </button>
      </div>

      {found !== null ? (
        <ul className="tree__list tree__list--found" aria-label={`Files matching ${found.query}`}>
          {found.paths.length === 0 ? <li className="panel__empty">No matches</li> : null}
          {found.paths.map((path) => {
            const kind = statusKindFor(path, changes)
            return (
              <li key={path}>
                <button
                  type="button"
                  className="tree__row tree__row--found"
                  title={path}
                  onClick={() => open(path)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ path, at: { x: event.clientX, y: event.clientY } })
                  }}
                >
                  <span className="tree__name">
                    <span className="tree__dir">{directoryOf(path)}</span>
                    {fileNameOf(path)}
                  </span>
                  {kind === null ? null : (
                    <span className={`tree__status change__kind change__kind--${kind}`}>{KIND_LETTER[kind]}</span>
                  )}
                </button>
              </li>
            )
          })}
          {found.truncated ? <li className="panel__note">First {found.paths.length}</li> : null}
        </ul>
      ) : root?.entries === null || root === undefined ? (
        <p className="panel__empty">{root?.error ?? 'Reading…'}</p>
      ) : (
        <ul className="tree__list" role="tree" aria-label="Files">
          {rows.length === 0 ? <li className="panel__empty">Empty</li> : null}
          {rows.map((row) => {
            const kind = row.kind === 'dir' ? null : statusKindFor(row.path, changes)
            const under = row.kind === 'dir' ? changesUnder(row.path, changes) : 0
            return (
              <li
                key={row.path}
                role="treeitem"
                aria-level={row.depth + 1}
                {...(row.kind === 'dir' ? { 'aria-expanded': row.expanded } : {})}
              >
                <div className={`tree__item${row.ignored ? ' tree__item--ignored' : ''}`}>
                  <button
                    type="button"
                    className={`tree__row tree__row--${row.kind}`}
                    style={{ ['--depth' as string]: row.depth }}
                    title={row.error ?? row.path}
                    onClick={() => toggle(row)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenu({ path: row.path, at: { x: event.clientX, y: event.clientY } })
                    }}
                  >
                    {row.kind === 'dir' ? (
                      <svg
                        className={`chevron${row.expanded ? ' chevron--open' : ''}`}
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                      >
                        <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
                      </svg>
                    ) : (
                      <span className="tree__leaf" aria-hidden="true" />
                    )}
                    <span className="tree__name">{row.name}</span>
                    {row.kind === 'symlink' ? <span className="tree__kind">link</span> : null}
                    {row.loading ? <span className="tree__kind">…</span> : null}
                    {kind === null ? null : (
                      <span className={`tree__status change__kind change__kind--${kind}`}>{KIND_LETTER[kind]}</span>
                    )}
                    {under > 0 ? <span className="tree__under" title={`${under} changed inside`} /> : null}
                  </button>
                  <button
                    type="button"
                    className="tree__reveal"
                    aria-label={`Reveal ${row.name} in Finder`}
                    title="Reveal in Finder"
                    onClick={() => reveal(row.path)}
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M1 3 H4.5 L6 4.5 H11 V9.5 H1 Z" />
                    </svg>
                  </button>
                </div>
                {row.kind === 'dir' && row.expanded && row.truncated ? (
                  <p className="panel__note">First {tree.dirs[row.path]?.entries?.length ?? 0}</p>
                ) : null}
              </li>
            )
          })}
          {root.truncated ? <li className="panel__note">First {root.entries.length}</li> : null}
        </ul>
      )}

      {menu === null ? null : (
        <RowMenu
          label={`Actions for ${menu.path}`}
          anchor={menu.at}
          onClose={() => setMenu(null)}
          items={[
            { label: `Open in ${label}`, onChoose: () => openInTheEditor(menu.path) },
            { label: 'Reveal in Finder', onChoose: () => reveal(menu.path) },
            {
              label: 'Copy path',
              onChoose: () => void copyToClipboard(absolute(menu.path), `the path to ${menu.path}`)
            }
          ]}
        />
      )}
    </section>
  )
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
