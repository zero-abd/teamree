// The patch laid out for review: files and hunks fold, lines carry both numbers, and the `@@` header
// sticks while you read its hunk. The patch stays the source of truth; colour comes from the small
// tokenizer in `src/shared/syntax.ts`, not an editor with its own model of the file.

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePatch, type PatchFile, type PatchHunk, type PatchLine } from '@shared/patch'
import { syntaxLanguage, tokenizeLine, type SyntaxLanguage, type SyntaxToken } from '@shared/syntax'
import { CommentComposer } from '../review/CommentComposer'
import { hunkLabel } from '../review/reviewModel'
import type { DiffLayout } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { changedSpans, sourceHunk, withoutWhitespace, type Spans } from './lineDiff'

/** What a file's header says happened to it, when it is worth saying. */
const STATUS_NOTE: Record<PatchFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: ''
}

/** A hunk heavier than this opens on its first lines only; see `lineCost`. */
const FOLD_OVER = 500

/** What one patch draws when it opens; hunks past it start folded. */
const DRAW_BUDGET = 2000

/** The most a heavy hunk draws on open: one task's rows, so the next step leaves them be. */
const HEAD_LINES = 400

/** Lines each `Show more` adds to a hunk. */
const MORE_LINES = 2000

/** Lockfiles and minified output: nobody reads them line by line. */
const GENERATED =
  /(^|\/)([^/]*-lock\.(json|yaml)|npm-shrinkwrap\.json|go\.sum|[^/]+\.lock|[^/]+\.min\.(js|mjs|cjs|css)|[^/]+\.map)$/

/** Below this many pixels two columns of code are too narrow to read. */
export const SPLIT_MIN_WIDTH = 720

/** The layout a patch gets at `width`: side by side falls back to inline where it does not fit. */
export function fitLayout(chosen: DiffLayout, width: number | null): DiffLayout {
  return chosen === 'split' && width !== null && width < SPLIT_MIN_WIDTH ? 'inline' : chosen
}

/** The verb on a hunk header's control; which one follows from the half of the patch the hunk is in. */
export type HunkAction = 'Stage Hunk' | 'Unstage Hunk'

/** A line by its place in the parsed patch. */
export type PatchPlace = { file: number; hunk: number; line: number }

/** Viewed boxes on each file's header; a viewed file is drawn folded. */
export type PatchViewing = {
  viewed: (file: PatchFile) => boolean
  onViewed: (file: PatchFile, viewed: boolean) => void
}

/** Lines of one hunk a comment is being written on: the hunk by `file:hunk`, its lines by index, `from` <= `to`. */
type Draft = { place: string; from: number; to: number }

/** A cut patch's way to the rest: the whole patch's changed lines, and reading on while it loads. */
export type PatchMore = {
  totalLines?: number | undefined
  loading?: boolean
  /** Absent once reading on has gone as far as it will. */
  onShowAll?: (() => void) | undefined
  onStop?: () => void
  /** Offered in place of `Show Full Diff` for a generated file, or once that is spent. */
  onOpenFile?: ((path: string) => void) | undefined
}

export type PatchViewProps = {
  /** The worktree a `+` on a line writes a comment for its agent in; absent offers none. */
  commentsIn?: string
  viewing?: PatchViewing
  more?: PatchMore
}

export function PatchView({
  patch,
  truncated,
  layout,
  action,
  busy = false,
  reveal = null,
  named = false,
  onHunk,
  onDiscard,
  commentsIn,
  viewing,
  more
}: PatchViewProps & {
  patch: string
  truncated: boolean
  layout: DiffLayout
  /** The pane already names the file, so a patch of one file draws no header for it. */
  named?: boolean
  /** The verb every hunk here is offered; absent leaves the patch read-only. */
  action?: HunkAction
  /** True while one is in flight, so a second click cannot race the first. */
  busy?: boolean
  /** A line find landed on: its hunk unfolds and draws down to it. */
  reveal?: PatchPlace | null
  onHunk?: (file: PatchFile, hunk: PatchHunk) => void
  /** Offers `Discard` on each hunk of a modified or renamed file; a whole-file change is discarded as a file. */
  onDiscard?: (file: PatchFile, hunk: PatchHunk) => void
}): React.JSX.Element {
  const { wrap, hideWhitespace } = useWorkspaceStore((state) => state.diffOptions)
  // Once per patch: the panel re-renders on every refresh tick and a patch is thousands of lines.
  const parsed = useMemo(() => parsePatch(patch), [patch])
  const files = useMemo(() => (hideWhitespace ? withoutWhitespace(parsed) : parsed), [parsed, hideWhitespace])
  const opening = useMemo(() => linesOnOpen(files), [files])
  const headless = named && files.length === 1
  const [draft, setDraft] = useState<Draft | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  // Stable, so a hunk's memoised rows redraw only when the draft is theirs.
  const pick = useCallback(
    (place: string, line: number, extend: boolean): void =>
      setDraft((current) =>
        extend && current?.place === place
          ? { place, from: Math.min(current.from, line), to: Math.max(current.to, line) }
          : { place, from: line, to: line }
      ),
    []
  )
  useCommentKeys(root, commentsIn !== undefined, setDraft)

  return (
    <div className={`patch patch--${layout}${viewing ? ' patch--review' : ''}${wrap ? ' patch--wrap' : ''}`} ref={root}>
      {files.map((file, index) => (
        // The index: a rename of A to B plus an edit to A is two entries called A.
        <details
          className="patch__file"
          key={`${file.path}-${index}`}
          open={viewing === undefined || !viewing.viewed(parsed[index] ?? file)}
        >
          <summary className="patch__fileHead" hidden={headless}>
            {/* Split here rather than through the panel's own helpers, which
                would make this module and that one import each other for two
                calls to `lastIndexOf`. A path with no slash in it takes the
                same two slices and comes out whole. */}
            <span className="patch__fileName">
              <span className="patch__fileDir">{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span>
              {file.path.slice(file.path.lastIndexOf('/') + 1)}
            </span>
            {file.from === null ? null : <span className="patch__fileNote">from {file.from}</span>}
            {STATUS_NOTE[file.status] === '' ? null : (
              <span className="patch__fileNote">{STATUS_NOTE[file.status]}</span>
            )}
            {viewing === undefined ? null : (
              <label className="patch__viewed" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={viewing.viewed(parsed[index] ?? file)}
                  onChange={(event) => viewing.onViewed(parsed[index] ?? file, event.target.checked)}
                />
                Viewed
              </label>
            )}
          </summary>
          {file.binary ? (
            <p className="patch__binary">Binary file</p>
          ) : file.hunks.length === 0 ? (
            <p className="patch__binary">
              {(parsed[index]?.hunks.length ?? 0) > 0 ? 'Whitespace only' : 'No content changed'}
            </p>
          ) : (
            file.hunks.map((hunk, at) => (
              // By position: hunks of a truncated patch can share a header, and a duplicate key drops one.
              <HunkView
                hunk={hunk}
                key={at}
                place={`${index}:${at}`}
                language={syntaxLanguage(file.path)}
                layout={layout}
                startLines={opening[index]?.[at] ?? 0}
                revealLine={reveal?.file === index && reveal.hunk === at ? reveal.line : null}
                busy={busy}
                {...(commentsIn === undefined
                  ? {}
                  : {
                      onPick: pick,
                      ...(draft?.place === `${index}:${at}`
                        ? {
                            draft,
                            composer: (
                              <CommentComposer
                                worktreeId={commentsIn}
                                path={file.path}
                                lines={hunk.lines.slice(draft.from, draft.to + 1)}
                                onClose={() => setDraft(null)}
                              />
                            )
                          }
                        : {})
                    })}
                {...(action === undefined || onHunk === undefined
                  ? {}
                  : // A binary file has no hunks to reach this, and an added
                    // one stages whole — the runtime refuses a hunk of either,
                    // so the control is not offered for them here.
                    { action, onHunk: () => onHunk(parsed[index] ?? file, sourceHunk(hunk)) })}
                {...(onDiscard === undefined || (file.status !== 'modified' && file.status !== 'renamed')
                  ? {}
                  : { onDiscard: () => onDiscard(parsed[index] ?? file, sourceHunk(hunk)) })}
              />
            ))
          )}
        </details>
      ))}
      {truncated ? <PatchCut files={parsed} more={more} /> : null}
    </div>
  )
}

/** The end of a cut patch: how much of it is here, and the way to the rest. */
function PatchCut({ files, more }: { files: readonly PatchFile[]; more: PatchMore | undefined }): React.JSX.Element {
  const shown = useMemo(
    () => files.reduce((sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + changedIn(hunk), 0), 0),
    [files]
  )
  const total = more?.totalLines
  const last = files.at(-1)
  const onOpenFile = more?.onOpenFile
  const openFile = last === undefined || onOpenFile === undefined ? undefined : () => onOpenFile(last.path)
  const showAll =
    openFile !== undefined && last !== undefined && GENERATED.test(last.path) ? undefined : more?.onShowAll
  return (
    <div className="patch__cut">
      <span>
        Showing {shown.toLocaleString('en-US')}
        {total === undefined ? '' : ` of ${total.toLocaleString('en-US')}`} lines
      </span>
      {more?.loading === true ? (
        <>
          <progress className="patch__progress" {...(total === undefined ? {} : { max: total, value: shown })} />
          <button type="button" className="button" onClick={more.onStop}>
            Stop
          </button>
        </>
      ) : showAll !== undefined ? (
        <button type="button" className="button" onClick={showAll}>
          Show Full Diff
        </button>
      ) : openFile !== undefined ? (
        <button type="button" className="button" onClick={openFile}>
          Open File
        </button>
      ) : null}
    </div>
  )
}

function changedIn(hunk: PatchHunk): number {
  let changed = 0
  for (const line of hunk.lines) if (line.kind !== 'context') changed += 1
  return changed
}

/** `c`, or ⌘⇧A, with lines of this patch selected opens a comment on them. */
function useCommentKeys(root: React.RefObject<HTMLElement | null>, on: boolean, open: (draft: Draft) => void): void {
  const latest = useRef(open)
  latest.current = open
  useEffect(() => {
    if (!on) return
    const onKey = (event: KeyboardEvent): void => {
      const bare = event.key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      const chord = event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey) && event.shiftKey
      if (!bare && !chord) return
      if ((event.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm')) return
      const draft = selectedDraft(root.current, window.getSelection())
      if (draft === null) return
      event.preventDefault()
      latest.current(draft)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [root, on])
}

/** The lines a selection inside `root` covers, when it stays within one hunk. */
function selectedDraft(root: HTMLElement | null, selection: Selection | null): Draft | null {
  if (root === null || selection === null || selection.isCollapsed) return null
  const lineAt = (node: Node | null): { hunk: string; line: number } | null => {
    const element = node instanceof Element ? node : (node?.parentElement ?? null)
    const row = element?.closest('.patch__row')
    const hunk = row?.closest<HTMLElement>('[data-hunk]')
    if (!row || !hunk || !root.contains(hunk)) return null
    const lines = [...row.querySelectorAll<HTMLElement>('[data-line]')].map((line) => Number(line.dataset.line))
    return lines.length === 0 ? null : { hunk: hunk.dataset.hunk ?? '', line: Math.max(...lines) }
  }
  const anchor = lineAt(selection.anchorNode)
  const focus = lineAt(selection.focusNode)
  if (anchor === null || focus === null || anchor.hunk !== focus.hunk) return null
  return { place: anchor.hunk, from: Math.min(anchor.line, focus.line), to: Math.max(anchor.line, focus.line) }
}

/**
 * Lines each hunk draws on open, 0 folded: a light hunk all of them, a heavy one its first lines, while the
 * patch's budget lasts. Generated files start folded.
 */
function linesOnOpen(files: readonly PatchFile[]): number[][] {
  let left = DRAW_BUDGET
  return files.map((file) => {
    const generated = GENERATED.test(file.path)
    return file.hunks.map((hunk) => {
      if (generated) return 0
      let cost = 0
      for (const line of hunk.lines) cost += lineCost(line)
      if (cost <= FOLD_OVER) {
        if (cost > left) return 0
        left -= cost
        // Not its length: a hunk that grows on a refresh stays whole.
        return Infinity
      }
      let room = Math.min(left, HEAD_LINES)
      let lines = 0
      for (const line of hunk.lines) {
        const next = lineCost(line)
        if (next > room) break
        room -= next
        lines += 1
      }
      left -= Math.min(left, HEAD_LINES) - room
      return lines
    })
  })
}

/** A long line counts once per 120 characters: a minified line is thousands of tokens. */
function lineCost(line: PatchLine): number {
  return Math.max(1, Math.ceil(line.text.length / 120))
}

function HunkView({
  hunk,
  place,
  language,
  layout,
  startLines,
  revealLine,
  action,
  busy,
  onHunk,
  onDiscard,
  draft = null,
  onPick,
  composer = null
}: LineComments & {
  hunk: PatchHunk
  /** `file:hunk`, which find paints by. */
  place: string
  language: SyntaxLanguage | null
  layout: DiffLayout
  startLines: number
  revealLine: number | null
  action?: HunkAction
  busy: boolean
  onHunk?: () => void
  onDiscard?: () => void
}): React.JSX.Element {
  const [limit, setLimit] = useState(startLines)
  // Side by side, a row can carry two lines, so the line found is within twice its index.
  const need = revealLine === null ? 0 : (layout === 'split' ? 2 : 1) * (revealLine + 1)
  if (need > limit) setLimit(Math.ceil(need / ROWS_PER_TASK) * ROWS_PER_TASK)
  const more = useCallback(() => setLimit((now) => now + MORE_LINES), [])
  const head = useRef<HTMLElement | null>(null)
  const count = hunk.lines.length
  return (
    <details className="patch__hunk" open data-hunk={place}>
      {/* Sticky, and the reason the whole diff scrolls in one container: the
          `@@` line is the only thing on screen that says which part of the file
          is underneath the cursor, and it is the first thing to scroll away. */}
      <summary className="patch__hunkHead" ref={head}>
        {/* The header in a span of its own, so the control beside it is not
            part of the line somebody reads the position off. */}
        <span className="patch__hunkAt" title={hunk.header}>
          {hunkLabel(hunk)}
        </span>
        {onDiscard === undefined ? null : (
          <HunkButton label="Discard" busy={busy} onClick={onDiscard} className="patch__stage patch__discard" />
        )}
        {action === undefined || onHunk === undefined ? null : (
          <HunkButton label={action} busy={busy} onClick={onHunk} className="patch__stage" />
        )}
      </summary>
      {limit === 0 ? (
        <button
          type="button"
          className="patch__more"
          onClick={() => {
            setLimit(Infinity)
            // The button goes; the header keeps the keyboard in this hunk.
            head.current?.focus()
          }}
        >
          Show {count.toLocaleString('en-US')} {count === 1 ? 'line' : 'lines'}
        </button>
      ) : (
        // Keyed by layout, so a switch redraws from the top rather than all at once.
        <HunkLines
          key={layout}
          hunk={hunk}
          language={language}
          layout={layout}
          limit={limit}
          onMore={more}
          revealLine={revealLine}
          place={place}
          draft={draft}
          {...(onPick === undefined ? {} : { onPick })}
          composer={composer}
        />
      )}
    </details>
  )
}

/** Rows drawn per task once a hunk is shown: a long one appears at once and fills in behind. */
const ROWS_PER_TASK = 400

// Memoised: a Stage click flips `busy` on every hunk, and a shown hunk can be thousands of rows.
const HunkLines = memo(function HunkLines({
  hunk,
  language,
  layout,
  limit,
  onMore,
  revealLine,
  place,
  draft = null,
  onPick,
  composer = null
}: LineComments & {
  hunk: PatchHunk
  language: SyntaxLanguage | null
  layout: DiffLayout
  /** Lines to draw; the rest wait behind `Show more`. */
  limit: number
  onMore: () => void
  revealLine: number | null
  place: string
}): React.JSX.Element {
  const onPlus = useMemo(
    () => (onPick === undefined ? undefined : (line: number, extend: boolean) => onPick(place, line, extend)),
    [onPick, place]
  )
  const rows = useMemo(() => (layout === 'split' ? pairLines(hunk.lines) : null), [hunk, layout])
  const words = useMemo(() => changedSpans(hunk.lines), [hunk])
  // Each line's index, which find paints by; a split row does not keep it.
  const lineIndex = useMemo(
    () => (rows === null ? null : new Map(hunk.lines.map((line, index) => [line, index]))),
    [hunk, rows]
  )
  const shown = useMemo(() => rowsWithin(hunk, rows, limit), [hunk, rows, limit])
  const [drawn, setDrawn] = useState(ROWS_PER_TASK)
  const reach = rowOf(hunk, rows, revealLine) + 1
  if (reach > drawn) setDrawn(Math.ceil(reach / ROWS_PER_TASK) * ROWS_PER_TASK)
  useEffect(() => {
    if (drawn >= shown.rows) return
    const next = setTimeout(() => setDrawn((now) => now + ROWS_PER_TASK), 0)
    return () => clearTimeout(next)
  }, [drawn, shown.rows])
  const end = Math.min(drawn, shown.rows)
  const slices: number[] = []
  for (let from = 0; from < end; from += ROWS_PER_TASK) slices.push(from)
  const hidden = hunk.lines.length - shown.lines
  return (
    <div className="patch__lines">
      {slices.map((from) =>
        rows === null || lineIndex === null ? (
          <InlineRows
            key={from}
            lines={hunk.lines}
            from={from}
            to={Math.min(from + ROWS_PER_TASK, end)}
            language={language}
            words={words}
            draft={draft}
            {...(onPlus === undefined ? {} : { onPlus })}
            composer={composer}
          />
        ) : (
          <SplitRows
            key={from}
            rows={rows}
            lineIndex={lineIndex}
            from={from}
            to={Math.min(from + ROWS_PER_TASK, end)}
            language={language}
            words={words}
            draft={draft}
            {...(onPlus === undefined ? {} : { onPlus })}
            composer={composer}
          />
        )
      )}
      {hidden > 0 ? (
        <button type="button" className="patch__more" onClick={onMore}>
          Show {Math.min(MORE_LINES, hidden).toLocaleString('en-US')} more lines
          {hidden > MORE_LINES ? ` · ${hidden.toLocaleString('en-US')} hidden` : ''}
        </button>
      ) : null}
    </div>
  )
})

/** The rows that draw no more than `limit` of the hunk's lines, and the lines they draw. */
function rowsWithin(hunk: PatchHunk, rows: readonly PatchRow[] | null, limit: number): { rows: number; lines: number } {
  if (rows === null) {
    const lines = Math.min(limit, hunk.lines.length)
    return { rows: lines, lines }
  }
  let lines = 0
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at] as PatchRow
    const next = lines + (row.old === null ? 0 : 1) + (row.new === null || row.new === row.old ? 0 : 1)
    if (next > limit) return { rows: at, lines }
    lines = next
  }
  return { rows: rows.length, lines }
}

/** The row `line` is drawn on, or -1. */
function rowOf(hunk: PatchHunk, rows: readonly PatchRow[] | null, line: number | null): number {
  if (line === null) return -1
  if (rows === null) return line
  const target = hunk.lines[line]
  return rows.findIndex((row) => row.old === target || row.new === target)
}

const InlineRows = memo(function InlineRows({
  lines,
  from,
  to,
  language,
  words,
  draft = null,
  onPlus,
  composer = null
}: LineComments & {
  lines: readonly PatchLine[]
  from: number
  to: number
  language: SyntaxLanguage | null
  words: ReadonlyMap<PatchLine, Spans>
}): React.JSX.Element {
  return (
    <>
      {lines.slice(from, to).map((line, offset) => {
        const index = from + offset
        return (
          // Two lines can be byte-identical and still be different lines.
          <Fragment key={offset}>
            <div className={`patch__row patch__row--${line.kind}${rowPicked(draft, index)}`}>
              <Plus line={line} index={index} onPlus={onPlus} />
              <span className="patch__num">{line.oldNumber ?? ''}</span>
              <span className="patch__num">{line.newNumber ?? ''}</span>
              <Text line={line} index={index} language={language} spans={words.get(line)} />
            </div>
            {draft?.to === index ? composer : null}
          </Fragment>
        )
      })}
    </>
  )
})

/** What a hunk's rows need to offer a comment: the lines picked, the `+`, and the composer under them. */
type LineComments = {
  draft?: Draft | null
  onPlus?: (line: number, extend: boolean) => void
  onPick?: (place: string, line: number, extend: boolean) => void
  composer?: React.ReactNode
}

function rowPicked(draft: Draft | null, index: number): string {
  return draft !== null && index >= draft.from && index <= draft.to ? ' patch__row--picked' : ''
}

/** The gutter's `+`: a comment on this line, or with shift down to it from the line picked before. */
function Plus({
  line,
  index,
  onPlus
}: {
  line: PatchLine | null
  index: number
  onPlus: LineComments['onPlus']
}): React.JSX.Element | null {
  if (onPlus === undefined || line === null || index < 0) return null
  const number = line.newNumber ?? line.oldNumber
  return (
    <button
      type="button"
      className="patch__plus"
      aria-label={`Comment on line ${number ?? ''}`.trim()}
      onClick={(event) => onPlus(index, event.shiftKey)}
    >
      +
    </button>
  )
}

const SplitRows = memo(function SplitRows({
  rows,
  lineIndex,
  from,
  to,
  language,
  words,
  draft = null,
  onPlus,
  composer = null
}: LineComments & {
  rows: readonly PatchRow[]
  lineIndex: ReadonlyMap<PatchLine, number>
  from: number
  to: number
  language: SyntaxLanguage | null
  words: ReadonlyMap<PatchLine, Spans>
}): React.JSX.Element {
  return (
    <>
      {rows.slice(from, to).map((row, offset) => {
        const oldIndex = row.old === null ? -1 : (lineIndex.get(row.old) ?? -1)
        const newIndex = row.new === null ? -1 : (lineIndex.get(row.new) ?? -1)
        // The later of the two, so a comment on a changed pair takes both and the composer lands under it.
        const index = Math.max(oldIndex, newIndex)
        const last = draft !== null && (draft.to === oldIndex || draft.to === newIndex)
        return (
          <Fragment key={offset}>
            <div className={`patch__row patch__row--split${rowPicked(draft, index) || rowPicked(draft, oldIndex)}`}>
              <Plus line={row.new ?? row.old} index={index} onPlus={onPlus} />
              <Side line={row.old} index={oldIndex} side="old" language={language} words={words} />
              <Side line={row.new} index={newIndex} side="new" language={language} words={words} />
            </div>
            {last ? composer : null}
          </Fragment>
        )
      })}
    </>
  )
})

function HunkButton({
  label,
  busy,
  onClick,
  className
}: {
  label: string
  busy: boolean
  onClick: () => void
  className: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      // Inside a `summary`, a click folds the hunk unless the button stops it.
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      {label}
    </button>
  )
}

/** One column of a side-by-side row; an empty one is the other side's gap. */
function Side({
  line,
  index,
  side,
  language,
  words
}: {
  line: PatchLine | null
  index: number
  side: 'old' | 'new'
  language: SyntaxLanguage | null
  words: ReadonlyMap<PatchLine, Spans>
}): React.JSX.Element {
  if (line === null) return <span className="patch__side patch__side--gap" />
  return (
    <span className={`patch__side patch__side--${line.kind}`}>
      <span className="patch__num">{(side === 'old' ? line.oldNumber : line.newNumber) ?? ''}</span>
      <Text line={line} index={index} language={language} spans={words.get(line)} />
    </span>
  )
}

/** The line's own text, with the marker git put in column one beside it; `index` is its place in the hunk. */
function Text({
  line,
  index,
  language,
  spans
}: {
  line: PatchLine
  index: number
  language: SyntaxLanguage | null
  /** The words that differ from the line it pairs with. */
  spans?: Spans | undefined
}): React.JSX.Element {
  const sign = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
  return (
    <>
      <span className={`patch__sign patch__sign--${line.kind}`}>{sign}</span>
      <code className="patch__text" data-line={index}>
        {markTokens(tokenizeLine(line.text, language), spans).map((token, index) => (
          <span className={`patch__tok patch__tok--${token.kind}${token.changed ? ' patch__word' : ''}`} key={index}>
            {token.text}
          </span>
        ))}
        {line.noNewline ? (
          <span className="patch__nonl" title="No newline at end of file">
            ↵
          </span>
        ) : null}
      </code>
    </>
  )
}

/** The tokens cut at the spans' edges, each piece saying whether it is inside one. */
function markTokens(
  tokens: readonly SyntaxToken[],
  spans: Spans | undefined
): readonly (SyntaxToken & { changed?: boolean })[] {
  if (spans === undefined || spans.length === 0) return tokens
  const pieces: (SyntaxToken & { changed: boolean })[] = []
  let offset = 0
  let span = 0
  for (const token of tokens) {
    const end = offset + token.text.length
    let at = offset
    while (at < end) {
      while (span < spans.length && (spans[span] as readonly [number, number])[1] <= at) span += 1
      const [start, stop] = spans[span] ?? [end, end]
      const inside = start <= at
      const until = Math.min(end, inside ? stop : start)
      pieces.push({ ...token, text: token.text.slice(at - offset, until - offset), changed: inside })
      at = until
    }
    offset = end
  }
  return pieces
}

export type PatchRow = {
  old: PatchLine | null
  new: PatchLine | null
}

/** A hunk's lines paired into two-column rows by position within a run; the short side gets a gap. */
export function pairLines(lines: readonly PatchLine[]): PatchRow[] {
  const rows: PatchRow[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]
    if (line === undefined) break
    if (line.kind === 'context') {
      rows.push({ old: line, new: line })
      at += 1
      continue
    }
    const removed: PatchLine[] = []
    while (lines[at]?.kind === 'removed') {
      removed.push(lines[at] as PatchLine)
      at += 1
    }
    const added: PatchLine[] = []
    while (lines[at]?.kind === 'added') {
      added.push(lines[at] as PatchLine)
      at += 1
    }
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      rows.push({ old: removed[index] ?? null, new: added[index] ?? null })
    }
  }
  return rows
}
