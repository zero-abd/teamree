// A commit as a tab of the file column: its patch read-only, in the diff's layouts, with find.

import { useEffect, useRef, useState } from 'react'
import type { WorktreeCommitPatch } from '@shared/entities'
import type { FilePaneProps } from '../panes/FilePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { fitLayout } from '../workspace/PatchView'
import { CommitGlyph, FileBar } from './FileBar'
import { LayoutTools, ReadOnlyDiffBody, useWidth } from './FileDiff'

/** `path` is the tab's title, `5bb16ed Add sub`. */
export function CommitView({
  worktreeId,
  path,
  sha,
  focused,
  onFocus,
  onClose,
  onHeaderMenu,
  onMenu,
  searchToken = 0,
  onCloseSearch
}: FilePaneProps & { sha: string }): React.JSX.Element {
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const [commit, setCommit] = useState<WorktreeCommitPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const width = useWidth(body, true)
  const layout = fitLayout(diffLayout, width)

  // Read once: a commit does not change under its id.
  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.showCommit', { worktreeId, sha })
      .then((next) => {
        if (alive) setCommit(next)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [worktreeId, sha])

  return (
    <section
      className={`pane file${focused ? ' pane--focused' : ''}`}
      aria-label={path}
      onMouseDownCapture={onFocus}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      <FileBar
        path={path}
        name={path}
        title={commit === null ? sha : `${sha}\n${commit.author} · ${commit.committedAt}`}
        unsaved={false}
        glyph={<CommitGlyph />}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
        <LayoutTools layout={layout} bodyWidth={width} />
      </FileBar>
      <div className="file__body" ref={body}>
        <ReadOnlyDiffBody
          patch={commit?.patch ?? null}
          truncated={commit?.truncated ?? false}
          error={error}
          layout={layout}
          searchToken={searchToken}
          onCloseSearch={onCloseSearch}
        />
      </div>
    </section>
  )
}
