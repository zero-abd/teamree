// The patch laid out for review: files and hunks fold, lines carry both numbers, and the `@@` header
// sticks while you read its hunk. The patch stays the source of truth; colour comes from the small
// tokenizer in `src/shared/syntax.ts`, not an editor with its own model of the file.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { parsePatch, type PatchFile, type PatchHunk, type PatchLine } from '@shared/patch'
import { syntaxLanguage, tokenizeLine, type SyntaxLanguage } from '@shared/syntax'
import type { DiffLayout } from '../state/preferences'

/** What a file's header says happened to it, when it is worth saying. */
const STATUS_NOTE: Record<PatchFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: ''
}

/** A hunk heavier than this starts folded; see `drawCost`. */
const FOLD_OVER = 500

/** What one patch draws when it opens; hunks past it start folded. */
const DRAW_BUDGET = 2000

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
export type HunkAction = 'Stage' | 'Unstage'

export function PatchView({
  patch,
  truncated,
  layout,
  action,
  busy = false,
  onHunk,
  onDiscard
}: {
  patch: string
  truncated: boolean
  layout: DiffLayout
  /** The verb every hunk here is offered; absent leaves the patch read-only. */
  action?: HunkAction
  /** True while one is in flight, so a second click cannot race the first. */
  busy?: boolean
  onHunk?: (file: PatchFile, hunk: PatchHunk) => void
  /** Offers `Discard` on each hunk of a modified or renamed file; a whole-file change is discarded as a file. */
  onDiscard?: (file: PatchFile, hunk: PatchHunk) => void
}): React.JSX.Element {
  // Once per patch: the panel re-renders on every refresh tick and a patch is thousands of lines.
  const files = useMemo(() => parsePatch(patch), [patch])
  const folded = useMemo(() => foldOnOpen(files), [files])

  return (
    <div className={`patch patch--${layout}`}>
      {files.map((file, index) => (
        // The index: a rename of A to B plus an edit to A is two entries called A.
        <details className="patch__file" key={`${file.path}-${index}`} open>
          <summary className="patch__fileHead">
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
          </summary>
          {file.binary ? (
            <p className="patch__binary">Binary file</p>
          ) : file.hunks.length === 0 ? (
            <p className="patch__binary">No content changed</p>
          ) : (
            file.hunks.map((hunk, at) => (
              // By position: hunks of a truncated patch can share a header, and a duplicate key drops one.
              <HunkView
                hunk={hunk}
                key={at}
                language={syntaxLanguage(file.path)}
                layout={layout}
                startFolded={folded[index]?.[at] ?? false}
                busy={busy}
                {...(action === undefined || onHunk === undefined
                  ? {}
                  : // A binary file has no hunks to reach this, and an added
                    // one stages whole — the runtime refuses a hunk of either,
                    // so the control is not offered for them here.
                    { action, onHunk: () => onHunk(file, hunk) })}
                {...(onDiscard === undefined || (file.status !== 'modified' && file.status !== 'renamed')
                  ? {}
                  : { onDiscard: () => onDiscard(file, hunk) })}
              />
            ))
          )}
        </details>
      ))}
      {truncated ? <p className="patch__cut">… cut short</p> : null}
    </div>
  )
}

/** Which hunks open folded: generated files, heavy hunks, and whatever is past the patch's budget. */
function foldOnOpen(files: readonly PatchFile[]): boolean[][] {
  let drawn = 0
  return files.map((file) => {
    const generated = GENERATED.test(file.path)
    return file.hunks.map((hunk) => {
      const cost = drawCost(hunk)
      const fold = generated || cost > FOLD_OVER || drawn + cost > DRAW_BUDGET
      if (!fold) drawn += cost
      return fold
    })
  })
}

/** A hunk's lines, a long one counting once per 120 characters: a minified line is thousands of tokens. */
function drawCost(hunk: PatchHunk): number {
  let cost = 0
  for (const line of hunk.lines) cost += Math.max(1, Math.ceil(line.text.length / 120))
  return cost
}

function HunkView({
  hunk,
  language,
  layout,
  startFolded,
  action,
  busy,
  onHunk,
  onDiscard
}: {
  hunk: PatchHunk
  language: SyntaxLanguage | null
  layout: DiffLayout
  startFolded: boolean
  action?: HunkAction
  busy: boolean
  onHunk?: () => void
  onDiscard?: () => void
}): React.JSX.Element {
  const [folded, setFolded] = useState(startFolded)
  const head = useRef<HTMLElement | null>(null)
  const count = hunk.lines.length
  return (
    <details className="patch__hunk" open>
      {/* Sticky, and the reason the whole diff scrolls in one container: the
          `@@` line is the only thing on screen that says which part of the file
          is underneath the cursor, and it is the first thing to scroll away. */}
      <summary className="patch__hunkHead" ref={head}>
        {/* The header in a span of its own, so the control beside it is not
            part of the line somebody reads the position off. */}
        <span className="patch__hunkAt">{hunk.header}</span>
        {onDiscard === undefined ? null : (
          <HunkButton label="Discard" busy={busy} onClick={onDiscard} className="patch__stage patch__discard" />
        )}
        {action === undefined || onHunk === undefined ? null : (
          <HunkButton label={action} busy={busy} onClick={onHunk} className="patch__stage" />
        )}
      </summary>
      {folded ? (
        <button
          type="button"
          className="patch__more"
          onClick={() => {
            setFolded(false)
            // The button goes; the header keeps the keyboard in this hunk.
            head.current?.focus()
          }}
        >
          Show {count.toLocaleString('en-US')} {count === 1 ? 'line' : 'lines'}
        </button>
      ) : (
        // Keyed by layout, so a switch redraws from the top rather than all at once.
        <HunkLines key={layout} hunk={hunk} language={language} layout={layout} />
      )}
    </details>
  )
}

/** Rows drawn per task once a hunk is shown: a long one appears at once and fills in behind. */
const ROWS_PER_TASK = 500

// Memoised: a Stage click flips `busy` on every hunk, and a shown hunk can be thousands of rows.
const HunkLines = memo(function HunkLines({
  hunk,
  language,
  layout
}: {
  hunk: PatchHunk
  language: SyntaxLanguage | null
  layout: DiffLayout
}): React.JSX.Element {
  const rows = useMemo(() => (layout === 'split' ? pairLines(hunk.lines) : null), [hunk, layout])
  const total = rows?.length ?? hunk.lines.length
  const [drawn, setDrawn] = useState(ROWS_PER_TASK)
  useEffect(() => {
    if (drawn >= total) return
    const next = setTimeout(() => setDrawn((now) => now + ROWS_PER_TASK), 0)
    return () => clearTimeout(next)
  }, [drawn, total])
  const slices: number[] = []
  for (let from = 0; from < Math.min(drawn, total); from += ROWS_PER_TASK) slices.push(from)
  return (
    <div className="patch__lines">
      {slices.map((from) =>
        rows === null ? (
          <InlineRows key={from} lines={hunk.lines} from={from} language={language} />
        ) : (
          <SplitRows key={from} rows={rows} from={from} language={language} />
        )
      )}
    </div>
  )
})

const InlineRows = memo(function InlineRows({
  lines,
  from,
  language
}: {
  lines: readonly PatchLine[]
  from: number
  language: SyntaxLanguage | null
}): React.JSX.Element {
  return (
    <>
      {lines.slice(from, from + ROWS_PER_TASK).map((line, index) => (
        // Two lines can be byte-identical and still be different lines.
        <div className={`patch__row patch__row--${line.kind}`} key={index}>
          <span className="patch__num">{line.oldNumber ?? ''}</span>
          <span className="patch__num">{line.newNumber ?? ''}</span>
          <Text line={line} language={language} />
        </div>
      ))}
    </>
  )
})

const SplitRows = memo(function SplitRows({
  rows,
  from,
  language
}: {
  rows: readonly PatchRow[]
  from: number
  language: SyntaxLanguage | null
}): React.JSX.Element {
  return (
    <>
      {rows.slice(from, from + ROWS_PER_TASK).map((row, index) => (
        <div className="patch__row patch__row--split" key={index}>
          <Side line={row.old} side="old" language={language} />
          <Side line={row.new} side="new" language={language} />
        </div>
      ))}
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
  side,
  language
}: {
  line: PatchLine | null
  side: 'old' | 'new'
  language: SyntaxLanguage | null
}): React.JSX.Element {
  if (line === null) return <span className="patch__side patch__side--gap" />
  return (
    <span className={`patch__side patch__side--${line.kind}`}>
      <span className="patch__num">{(side === 'old' ? line.oldNumber : line.newNumber) ?? ''}</span>
      <Text line={line} language={language} />
    </span>
  )
}

/** The line's own text, with the marker git put in column one beside it. */
function Text({ line, language }: { line: PatchLine; language: SyntaxLanguage | null }): React.JSX.Element {
  const sign = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
  return (
    <>
      <span className={`patch__sign patch__sign--${line.kind}`}>{sign}</span>
      <code className="patch__text">
        {tokenizeLine(line.text, language).map((token, index) => (
          <span className={`patch__tok patch__tok--${token.kind}`} key={index}>
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
