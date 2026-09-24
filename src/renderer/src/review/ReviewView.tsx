// Every change of a worktree as one tab of the file column: the task and what its agent last said, then each
// file in the Changes list's order with a Viewed box, read-only, with comments to the agent.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorktreeDiff } from '@shared/entities'
import { parsePatch, type PatchFile } from '@shared/patch'
import { AgentGlyph } from '../agents/glyphs'
import { FileBar } from '../files/FileBar'
import { LayoutTools, ReadOnlyDiffBody, useWidth } from '../files/FileDiff'
import type { FilePaneProps } from '../panes/FilePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { paneAgent } from '../sidebar/agentRows'
import { usePaneEvidence } from '../sidebar/usePaneEvidence'
import { useWorkspaceStore } from '../state/workspaceStore'
import { fitLayout, type PatchViewing } from '../workspace/PatchView'
import { inChangesOrder, isViewedFile, viewedMark } from './reviewModel'
import { useReviewStore } from './reviewStore'

/** `path` is the tab's title. */
export function ReviewView({
  worktreeId,
  path,
  focused,
  onFocus,
  onClose,
  tabbed,
  onHeaderMenu,
  onMenu,
  searchToken = 0,
  onCloseSearch
}: FilePaneProps): React.JSX.Element {
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const changes = useWorkspaceStore((state) => state.changes[worktreeId]?.changes)
  const viewed = useReviewStore((state) => state.viewed[worktreeId])
  const markViewed = useReviewStore((state) => state.markViewed)
  const [diff, setDiff] = useState<WorktreeDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const width = useWidth(body, true)
  const layout = fitLayout(diffLayout, width)

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.diff', { worktreeId, head: true })
      .then((next) => {
        if (!alive) return
        setDiff(next)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [worktreeId, filesEpoch])

  const patch = useMemo(() => (diff === null ? null : inChangesOrder(diff.patch, changes ?? [])), [diff, changes])
  const files = useMemo(() => (patch === null ? [] : parsePatch(patch)), [patch])
  const viewing: PatchViewing = {
    viewed: (file) => isViewedFile(viewed?.[file.path], file),
    onViewed: (file, on) => markViewed(worktreeId, file.path, on ? viewedMark(file) : null)
  }

  return (
    <section
      className={`pane file review${focused ? ' pane--focused' : ''}`}
      aria-label={path}
      onMouseDownCapture={onFocus}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      <FileBar
        name={path}
        label={files.length === 0 ? null : summary(files, files.filter(viewing.viewed).length)}
        title={path}
        unsaved={false}
        tabbed={tabbed}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
        <LayoutTools layout={layout} bodyWidth={width} />
      </FileBar>
      <div className="file__body" ref={body}>
        <ReadOnlyDiffBody
          patch={patch}
          truncated={diff?.truncated ?? false}
          error={error}
          layout={layout}
          searchToken={searchToken}
          onCloseSearch={onCloseSearch}
          lead={<ReviewHead worktreeId={worktreeId} />}
          patchProps={{ commentsIn: worktreeId, viewing }}
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return
            if ((event.target as Element).closest('input, select, textarea')) return
            const step = FILE_KEYS[event.key]
            if (step === undefined) return
            event.preventDefault()
            jumpFile(event.currentTarget, step)
          }}
        />
      </div>
    </section>
  )
}

const FILE_KEYS: Record<string, 1 | -1> = { j: 1, n: 1, k: -1, p: -1 }

/** `3 files · +12 −2`, and how many are viewed once any are. */
function summary(files: readonly PatchFile[], viewed: number): string {
  let added = 0
  let removed = 0
  for (const line of files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  const count = `${files.length} ${files.length === 1 ? 'file' : 'files'} · +${added} −${removed}`
  return viewed === 0 ? count : `${count} · ${viewed}/${files.length} viewed`
}

/** Scrolls the next or previous file's header to the top. */
function jumpFile(scroller: HTMLElement, step: 1 | -1): void {
  const top = scroller.getBoundingClientRect().top - scroller.scrollTop
  const starts = [...scroller.querySelectorAll('.patch__file')].map((file) => file.getBoundingClientRect().top - top)
  const at = scroller.scrollTop + 1
  const current = starts.findLastIndex((start) => start <= at)
  const target =
    step === 1 ? current + 1 : starts[current] !== undefined && starts[current] < at - 1 ? current : current - 1
  const start = starts[Math.max(0, Math.min(starts.length - 1, target))]
  if (start !== undefined) scroller.scrollTop = start
}

/** The task as it was typed, and the last line its agent printed. */
function ReviewHead({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const terminals = useWorkspaceStore((state) => state.terminals)
  const agents = useMemo(
    () =>
      Object.values(terminals).filter(
        (terminal) => terminal.worktreeId === worktreeId && paneAgent(terminal) !== undefined
      ),
    [terminals, worktreeId]
  )
  const evidence = usePaneEvidence(agents, terminals)
  const speaker = agents.find((terminal) => (evidence[terminal.id] ?? '') !== '')
  const kind = speaker === undefined ? undefined : paneAgent(speaker)
  return (
    <div className="review__head">
      <p className="review__task">{worktree?.task ?? worktree?.name ?? ''}</p>
      {speaker === undefined ? null : (
        <p className="review__said">
          {kind === undefined ? null : <AgentGlyph kind={kind} />}
          <span>{evidence[speaker.id]}</span>
        </p>
      )}
    </div>
  )
}
