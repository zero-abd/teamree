// A unified patch, read the way a person reads one.
//
// The panel that shows an agent's work used to colour a patch by its first
// character and stop there, which is enough to see that something changed and
// not enough to say what: no file boundaries you can fold away, no hunk you can
// point at, and — the one that sends people back to their editor — no line
// numbers. "It broke around line 212" is the sentence a review is made of, and
// a screen of `+`/`-` cannot produce it.
//
// So the patch is parsed into what it already is: files, each with hunks, each
// with lines that know their number on both sides. The patch stays the source
// of truth — nothing here reads the working tree, and nothing here is a fact
// git did not write down — which is what keeps this honest about a diff of a
// file that has moved on since it was taken.
//
// Deliberately tolerant. The patch this is given may have been cut short at a
// byte ceiling (see `readWorktreeDiff`), so a hunk with fewer lines than its
// header claims is an ordinary outcome and not a parse error: whatever arrived
// is rendered, and the note about the cut is the panel's to add.

/** What a line is doing, which is decided by the column git puts it in. */
export type PatchLineKind = 'added' | 'removed' | 'context'

export type PatchLine = {
  kind: PatchLineKind
  /** The text without the `+`/`-`/space marker that sits in column one. */
  text: string
  /** Its number in the file before the change; absent on an addition. */
  oldNumber: number | null
  /** Its number in the file after it; absent on a removal. */
  newNumber: number | null
  /** What `\ No newline at end of file` was said about, said about the line. */
  noNewline: boolean
}

export type PatchHunk = {
  /** The `@@ … @@` line as git wrote it, trailing section heading and all. */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: PatchLine[]
}

/** What happened to one file, and everything the patch says about it. */
export type PatchFile = {
  /** The path after the change; for a deletion, the path that was there. */
  path: string
  /** Where it came from, and only when git said it moved. */
  from: string | null
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  /** True when git declined to show the content, so `hunks` is empty. */
  binary: boolean
  hunks: PatchHunk[]
}

/**
 * Every file in a unified patch, with the numbers a reader needs to cite.
 *
 * The classification is positional, the way the format is: the first character
 * of a line decides what it is, and `---`/`+++` are headers rather than a
 * removal and an addition — the trap in every hand-rolled diff renderer, and
 * the reason this is one function with one set of rules rather than a test on
 * each side of the panel.
 *
 * Line numbers are counted off the hunk header rather than trusted from it: a
 * removed line advances only the old side, an added line only the new, and a
 * context line both. That is the whole arithmetic, and it is what makes the two
 * gutters agree with what the file itself would say.
 */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | undefined
  let hunk: PatchHunk | undefined
  let oldNumber = 0
  let newNumber = 0

  const start = (paths: { path: string; from: string | null }): void => {
    file = { path: paths.path, from: paths.from, status: 'modified', binary: false, hunks: [] }
    hunk = undefined
    files.push(file)
  }

  const all = patch.split('\n')
  for (const [index, line] of all.entries()) {
    // The empty string after the patch's final newline is not a line of it.
    if (line === '' && index === all.length - 1) continue

    if (line.startsWith('diff --git ')) {
      start(headerPaths(line.slice('diff --git '.length)))
      continue
    }

    // A patch that begins at a hunk — which is what a cut-short one handed back
    // from its second half would look like — still has lines worth showing, so
    // it gets a file with no name rather than nothing at all.
    if (file === undefined && (line.startsWith('@@') || line.startsWith('--- '))) start({ path: '', from: null })
    if (file === undefined) continue

    if (line.startsWith('@@')) {
      const parsed = hunkHeader(line)
      if (parsed === null) continue
      hunk = parsed
      oldNumber = parsed.oldStart
      newNumber = parsed.newStart
      file.hunks.push(parsed)
      continue
    }

    if (hunk === undefined) {
      // Still in the file's own preamble: the index line, the modes, and the
      // two statements that are the only record of a move git makes when the
      // content is identical enough that there are no hunks to read it from.
      if (line.startsWith('rename from ')) file.from = line.slice('rename from '.length)
      else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
      else if (line.startsWith('copy from ')) file.from = line.slice('copy from '.length)
      else if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      // Both spellings: the summary git prints by default, and the header above
      // the encoded payload `--binary` produces. Either way there is nothing
      // here a reader can be shown, and saying so is better than an empty file.
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const path = sidePath(line)
        // `/dev/null` on either side is git naming an absence, not a file.
        if (path === null) file.status = line.startsWith('--- ') ? 'added' : 'deleted'
        else if (line.startsWith('+++ ')) file.path = path
        else if (file.path === '') file.path = path
      }
      continue
    }

    // `\ No newline at end of file` is a remark about the line above it, and
    // belongs to that line rather than to the hunk: it is the difference
    // between two files that differ only in their last byte.
    if (line.startsWith('\\')) {
      const last = hunk.lines.at(-1)
      if (last) last.noNewline = true
      continue
    }

    // An empty context line is written as a single space, so an actually empty
    // one is something that has been through a tool that strips trailing
    // whitespace. Read as context rather than as the end of the hunk, because
    // ending it there would silently drop every line below it.
    const marker = line === '' ? ' ' : line[0]
    const text = line.slice(1)
    if (marker === '+') {
      hunk.lines.push({ kind: 'added', text, oldNumber: null, newNumber, noNewline: false })
      newNumber += 1
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'removed', text, oldNumber, newNumber: null, noNewline: false })
      oldNumber += 1
    } else {
      hunk.lines.push({ kind: 'context', text, oldNumber, newNumber, noNewline: false })
      oldNumber += 1
      newNumber += 1
    }
  }

  // A rename is only readable off the pair of paths, and the two statements
  // above are not always there: a rename with edits in it carries `---`/`+++`
  // as well, and those are what the panel ends up showing.
  for (const each of files) {
    if (each.from !== null && each.from !== each.path && each.status === 'modified') each.status = 'renamed'
  }
  return files
}

/** `-14,7 +14,9` out of a hunk header, with the count git leaves out at one. */
function hunkHeader(line: string): PatchHunk | null {
  const found = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (found === null) return null
  return {
    header: line,
    oldStart: Number(found[1]),
    oldCount: found[2] === undefined ? 1 : Number(found[2]),
    newStart: Number(found[3]),
    newCount: found[4] === undefined ? 1 : Number(found[4]),
    lines: []
  }
}

/** The path out of a `---`/`+++` line, or null when it names `/dev/null`. */
function sidePath(line: string): string | null {
  const raw = unquote(line.slice(4).replace(/\t.*$/, ''))
  if (raw === '/dev/null') return null
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw
}

/**
 * The two paths out of a `diff --git` line.
 *
 * Only reached when nothing better follows it — a binary file, or a pure
 * rename — because the line is genuinely ambiguous: the separator between the
 * two paths is a space, and a path may contain one. Git quotes a path it
 * cannot write plainly, which is the case that is read exactly; the rest is
 * split at the last ` b/`, which is right for every path that does not itself
 * contain that sequence.
 */
function headerPaths(rest: string): { path: string; from: string | null } {
  const quoted = /^"(.*)" "(.*)"$/.exec(rest)
  if (quoted !== null) {
    const from = strip(unquote(`"${quoted[1] ?? ''}"`))
    const path = strip(unquote(`"${quoted[2] ?? ''}"`))
    return { path, from: from === path ? null : from }
  }
  const cut = rest.lastIndexOf(' b/')
  if (cut === -1) return { path: strip(rest), from: null }
  const from = strip(rest.slice(0, cut))
  const path = strip(rest.slice(cut + 1))
  return { path, from: from === path ? null : from }
}

function strip(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

/** Git's own quoting, undone for the escapes it actually emits. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path
  return path.slice(1, -1).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}
