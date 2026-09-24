// Two runs of one task as a tab of the file column: per file, each run's patch against the commit both started from.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Worktree, WorktreeCompare } from '@shared/entities'
import { fileColumnIn, shownTabId } from '@shared/filePane'
import { compareRuns, type ComparedFile, type RunFile } from '@shared/runCompare'
import { AgentGlyph } from '../agents/glyphs'
import { FileBar } from '../files/FileBar'
import { LayoutTools, useWidth } from '../files/FileDiff'
import type { FilePaneProps } from '../panes/FilePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import type { DiffLayout } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { agentWords, worktreeDisplay, worktreeLabel, type WorktreeDisplay } from '../sidebar/worktreeDisplay'
import { fitLayout, PatchView } from '../workspace/PatchView'

type Run = { id: string; display: WorktreeDisplay; name: string }

/** `path` is the tab's title, `claude vs codex`; `other` is the sibling on the right. */
export function CompareView({
  paneId,
  worktreeId,
  path,
  other,
  focused,
  onFocus,
  onClose,
  tabbed,
  onHeaderMenu,
  onMenu
}: FilePaneProps & { other: string }): React.JSX.Element {
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  // Its own, and side by side first: two runs next to each other is the point of the tab.
  const [chosen, setChosen] = useState<DiffLayout>('split')
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const agents = useWorkspaceStore((state) => state.agents)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const [compared, setCompared] = useState<WorktreeCompare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const width = useWidth(body, true)
  const layout = fitLayout(chosen, width)
  const shown = useWorkspaceStore((state) => {
    const column = fileColumnIn(state.layouts[worktreeId]?.root ?? null)
    return state.activeWorktreeId === worktreeId && column !== null && shownTabId(column) === paneId
  })
  const foldForCompare = useWorkspaceStore((state) => state.foldForCompare)

  // Two runs side by side want the whole window; the sidebar and panel come back when the compare goes.
  useEffect(() => {
    if (!shown) return
    foldForCompare(true)
    return () => foldForCompare(false)
  }, [shown, foldForCompare])

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.compare', { worktreeId, otherId: other })
      .then((next) => {
        if (!alive) return
        setCompared(next)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [worktreeId, other, filesEpoch])

  // The runtime's refusal would name the gone run by id. Known only once this side is listed:
  // an empty list at launch is not a removal.
  const listed = (id: string): boolean => worktrees.some((worktree) => worktree.id === id)
  const removed = listed(worktreeId) && !listed(other)
  const kindOf = useMemo(() => agentWords(agents), [agents])
  const runs = [worktreeId, other].map((id) =>
    runOf(
      id,
      worktrees.find((worktree) => worktree.id === id),
      kindOf
    )
  )
  const files = useMemo(
    () => (compared === null ? [] : compareRuns(compared.left.patch, compared.right.patch)),
    [compared]
  )

  return (
    <section
      className={`pane file${focused ? ' pane--focused' : ''}`}
      aria-label={path}
      onMouseDownCapture={onFocus}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      {/* The tab reads both runs; the bar says where they started. */}
      <FileBar
        name={path}
        label={compared === null ? null : `from ${compared.base.slice(0, 7)}`}
        title={compared === null ? path : `${path}\nfrom ${compared.base}`}
        unsaved={false}
        tabbed={tabbed}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
        <LayoutTools layout={layout} bodyWidth={width} onChoose={setChosen} />
      </FileBar>
      <div className="file__body" ref={body}>
        {removed ? (
          <p className="file__state">
            Run removed{' '}
            <button type="button" className="file__tool" onClick={onClose}>
              Close
            </button>
          </p>
        ) : compared === null ? (
          <p className="file__state">{error ?? 'Reading…'}</p>
        ) : (
          <div className={`compare compare--${layout}`} tabIndex={-1}>
            <div className="compare__heads">
              {runs.map((run, side) => (
                <RunHead key={run.id} run={run} files={files} side={side === 0 ? 'left' : 'right'} />
              ))}
            </div>
            {files.length === 0 ? <p className="file__state">No changes</p> : null}
            {files.map((file) => (
              <FilePair key={file.path} file={file} runs={runs} layout={layout} />
            ))}
            {compared.left.truncated || compared.right.truncated ? <p className="patch__cut">… cut short</p> : null}
          </div>
        )}
      </div>
    </section>
  )
}

function runOf(id: string, worktree: Worktree | undefined, kindOf: ReturnType<typeof agentWords>): Run {
  if (worktree === undefined) return { id, display: { title: id }, name: id }
  const display = worktreeDisplay(worktree, kindOf)
  return { id, display, name: display.agent?.text ?? worktree.name }
}

function RunHead({
  run,
  files,
  side
}: {
  run: Run
  files: readonly ComparedFile[]
  side: 'left' | 'right'
}): React.JSX.Element {
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const touched = files.flatMap((file) => (file[side] === null ? [] : [file[side]]))
  const added = touched.reduce((sum, file) => sum + file.added, 0)
  const removed = touched.reduce((sum, file) => sum + file.removed, 0)
  const { agent, title } = run.display
  return (
    <div className="compare__head" role="group" aria-label={worktreeLabel(run.display)}>
      {agent === undefined ? null : (
        <span className="compare__agent">
          {agent.kind === undefined ? null : <AgentGlyph kind={agent.kind} decorative />}
          {agent.text}
        </span>
      )}
      <span className="compare__title" title={title}>
        {title}
      </span>
      <span className="compare__count">{touched.length === 1 ? '1 file' : `${touched.length} files`}</span>
      <span className="compare__stat compare__stat--added">+{added}</span>
      <span className="compare__stat compare__stat--removed">−{removed}</span>
      <button type="button" className="file__tool" onClick={() => void openWorktree(run.id)}>
        Open
      </button>
      <button
        type="button"
        className="file__tool"
        onClick={() => openDialog({ kind: 'confirm-keep', worktreeId: run.id })}
      >
        Keep
      </button>
    </div>
  )
}

function FilePair({
  file,
  runs,
  layout
}: {
  file: ComparedFile
  runs: readonly Run[]
  layout: DiffLayout
}): React.JSX.Element {
  const slash = file.path.lastIndexOf('/') + 1
  const only = file.left === null ? runs[1] : file.right === null ? runs[0] : undefined
  return (
    <section className="compare__file" aria-label={file.path}>
      <h3 className="compare__path">
        {slash === 0 ? null : <span className="patch__fileDir">{file.path.slice(0, slash)}</span>}
        {file.path.slice(slash)}
        {only === undefined ? null : <span className="compare__mark">only {only.name}</span>}
        {file.same ? <span className="compare__mark compare__mark--same">same</span> : null}
      </h3>
      <div className="compare__sides">
        <RunSide run={file.left} name={runs[0]?.name ?? ''} named={layout === 'inline'} />
        <RunSide run={file.right} name={runs[1]?.name ?? ''} named={layout === 'inline'} />
      </div>
    </section>
  )
}

/** One run's change to the file; named when the runs are stacked, since the heads no longer sit above it. */
function RunSide({ run, name, named }: { run: RunFile | null; name: string; named: boolean }): React.JSX.Element {
  return (
    <div className="compare__side">
      {named ? <span className="compare__sideName">{name}</span> : null}
      {run === null ? (
        <p className="compare__none">Untouched</p>
      ) : (
        <PatchView patch={run.patch} truncated={false} layout="inline" named />
      )}
    </div>
  )
}
