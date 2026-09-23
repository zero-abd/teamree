// The patch itself, laid out so it can be talked about.
//
// What was here before was the patch as git printed it, in a monospace block
// coloured by the first character of each line. That is enough to see that
// something changed. It is not enough to review: there is no line number to
// cite, no file boundary to fold away, and no way to hold one hunk still while
// reading the next — so a four-hundred-line change from an agent sends somebody
// back to their editor, which is the one moment this app exists for.
//
// So: files fold, hunks fold, every line carries its number on both sides, and
// the `@@` header sticks to the top of its hunk while you read down it, because
// the header is the only thing on screen that says where you are.
//
// The patch stays the source of truth. Nothing here reads the working tree and
// nothing here is an editor — text is rendered as text, a line at a time, and
// the colour on it comes from a tokenizer that knows a handful of languages and
// declines to guess at the rest (`src/shared/syntax.ts`). An editor component
// here would be a different decision about what this panel is for, and it would
// bring its own model of the file, which is exactly the thing a patch is not.

import { useMemo } from 'react'
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

/**
 * What the control on a hunk header does, and the word on it.
 *
 * A verb and nothing else. The panel is narrow, the two words are opposites,
 * and which one appears is already decided by which half of the patch the hunk
 * is in — a sentence explaining that would be longer than the patch.
 */
export type HunkAction = 'Stage' | 'Unstage'

export function PatchView({
  patch,
  truncated,
  layout,
  action,
  busy = false,
  onHunk
}: {
  patch: string
  truncated: boolean
  layout: DiffLayout
  /**
   * The verb every hunk here is offered. Absent leaves the patch read-only,
   * which is what every other caller of this component wants.
   */
  action?: HunkAction
  /** True while one is in flight, so a second click cannot race the first. */
  busy?: boolean
  onHunk?: (file: PatchFile, hunk: PatchHunk) => void
}): React.JSX.Element {
  // Parsed once per patch rather than per render: the panel re-renders on every
  // refresh tick the worktree produces, and a patch is a few thousand lines.
  const files = useMemo(() => parsePatch(patch), [patch])

  return (
    <div className={`patch patch--${layout}`}>
      {files.map((file, index) => (
        // The index, because two files in one patch can share a path: a rename
        // of A to B in the same patch as an edit to A is two entries called A.
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
            <p className="patch__binary">Binary file, not shown.</p>
          ) : file.hunks.length === 0 ? (
            <p className="patch__binary">No content changed.</p>
          ) : (
            file.hunks.map((hunk, at) => (
              // By position: two hunks of a patch cut short at a byte ceiling
              // can arrive with the same header and no content to tell them
              // apart, and a duplicate key drops one of them from the screen.
              <HunkView
                hunk={hunk}
                key={at}
                language={syntaxLanguage(file.path)}
                layout={layout}
                busy={busy}
                {...(action === undefined || onHunk === undefined
                  ? {}
                  : // A binary file has no hunks to reach this, and an added
                    // one stages whole — the runtime refuses a hunk of either,
                    // so the control is not offered for them here.
                    { action, onHunk: () => onHunk(file, hunk) })}
              />
            ))
          )}
        </details>
      ))}
      {truncated ? <p className="patch__cut">… cut short</p> : null}
    </div>
  )
}

function HunkView({
  hunk,
  language,
  layout,
  action,
  busy,
  onHunk
}: {
  hunk: PatchHunk
  language: SyntaxLanguage | null
  layout: DiffLayout
  action?: HunkAction
  busy: boolean
  onHunk?: () => void
}): React.JSX.Element {
  return (
    <details className="patch__hunk" open>
      {/* Sticky, and the reason the whole panel scrolls in one container: the
          `@@` line is the only thing on screen that says which part of the file
          is underneath the cursor, and it is the first thing to scroll away. */}
      <summary className="patch__hunkHead">
        {/* The header in a span of its own, so the control beside it is not
            part of the line somebody reads the position off. */}
        <span className="patch__hunkAt">{hunk.header}</span>
        {action === undefined || onHunk === undefined ? null : (
          <button
            type="button"
            className="patch__stage"
            disabled={busy}
            // The header is a `summary`, so a click inside it folds the hunk
            // unless the button keeps it. Nobody asking to stage a hunk is also
            // asking to stop looking at it.
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onHunk()
            }}
          >
            {action}
          </button>
        )}
      </summary>
      <div className="patch__lines">
        {layout === 'split'
          ? pairLines(hunk.lines).map((row, index) => (
              <div className="patch__row patch__row--split" key={index}>
                <Side line={row.old} side="old" language={language} />
                <Side line={row.new} side="new" language={language} />
              </div>
            ))
          : hunk.lines.map((line, index) => (
              // The index is the only identity a diff line has: two lines of a
              // patch can be byte-identical and still be different lines.
              <div className={`patch__row patch__row--${line.kind}`} key={index}>
                <span className="patch__num">{line.oldNumber ?? ''}</span>
                <span className="patch__num">{line.newNumber ?? ''}</span>
                <Text line={line} language={language} />
              </div>
            ))}
      </div>
    </details>
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

/**
 * A hunk's lines paired into rows, for the two-column layout.
 *
 * Git writes a replacement as every removal followed by every addition, so the
 * pairing is by position within a run and not by content: the first line taken
 * out sits beside the first line put in. Where one run is longer, the short
 * side gets a gap rather than a line borrowed from the next run — the numbers
 * in the gutters have to keep meaning what they say.
 */
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
