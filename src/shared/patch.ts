// A unified patch parsed into files, hunks and lines that know their number on
// both sides. Nothing here reads the working tree. Tolerant on purpose: the patch
// may have been cut at a byte ceiling (see `readWorktreeDiff`), so a short hunk is not an error.

export type PatchLineKind = 'added' | 'removed' | 'context'

export type PatchLine = {
  kind: PatchLineKind
  /** The text without the `+`/`-`/space marker that sits in column one. */
  text: string
  /** Its number in the file before the change; absent on an addition. */
  oldNumber: number | null
  /** Its number in the file after it; absent on a removal. */
  newNumber: number | null
  /** `\ No newline at end of file` was said about this line. */
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
 * Every file in a unified patch, with the numbers a reader needs to cite. Classification
 * is positional (`---`/`+++` are headers, not lines) and numbers are counted off the hunk header.
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

    // A patch that begins at a hunk (a cut-short one) gets a file with no name rather than nothing.
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
      // The file's preamble; the rename statements are the only record of a move with no hunks.
      if (line.startsWith('rename from ')) file.from = line.slice('rename from '.length)
      else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
      else if (line.startsWith('copy from ')) file.from = line.slice('copy from '.length)
      else if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      // Both spellings: the default summary, and the header `--binary` produces.
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

    // `\ No newline at end of file` is a remark about the line above it, not the hunk.
    if (line.startsWith('\\')) {
      const last = hunk.lines.at(-1)
      if (last) last.noNewline = true
      continue
    }

    // An empty context line is a single space; a truly empty one has been through
    // a whitespace-stripping tool. Read as context, else every line below is dropped.
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

  // A rename with edits carries `---`/`+++` too, so it is read off the pair of paths.
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

// The two paths out of a `diff --git` line, which is ambiguous (a path may contain
// a space): quoted paths are read exactly, the rest split at the last ` b/`.
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
