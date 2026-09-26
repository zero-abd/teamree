// git's conflict markers read back out of a file: the text around them, and each
// block with the side HEAD had, the base when diff3 wrote one, and the other side.

export type ConflictPart =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'conflict'
      /** 1-based line of its `<<<<<<<`. */
      line: number
      ours: string[]
      base?: string[]
      theirs: string[]
      oursLabel: string
      theirsLabel: string
    }

type Open = { line: number; ours: string[]; base?: string[]; theirs: string[]; oursLabel: string; raw: string[] }

/** The file in order; an unclosed block stays text, as git would leave it. */
export function parseConflicts(text: string): ConflictPart[] {
  const parts: ConflictPart[] = []
  let plain: string[] = []
  let open: Open | null = null
  let side: 'ours' | 'base' | 'theirs' = 'ours'
  const flush = (): void => {
    if (plain.length > 0) parts.push({ kind: 'text', lines: plain })
    plain = []
  }
  text.split('\n').forEach((line, index) => {
    if (open === null) {
      const start = marker(line, '<')
      if (start === null) plain.push(line)
      else {
        open = { line: index + 1, ours: [], theirs: [], oursLabel: start, raw: [line] }
        side = 'ours'
      }
      return
    }
    open.raw.push(line)
    if (side === 'ours' && marker(line, '|') !== null) {
      side = 'base'
      open.base = []
    } else if (side !== 'theirs' && marker(line, '=') === '') side = 'theirs'
    else if (side === 'theirs' && marker(line, '>') !== null) {
      flush()
      const { raw: _raw, ...block } = open
      parts.push({ kind: 'conflict', ...block, theirsLabel: marker(line, '>') ?? '' })
      open = null
    } else if (side === 'base') open.base?.push(line)
    else open[side].push(line)
  })
  if (open !== null) plain.push(...(open as Open).raw)
  flush()
  return parts
}

/** How many conflict blocks the file still holds. */
export function conflictCount(text: string): number {
  return parseConflicts(text).filter((part) => part.kind === 'conflict').length
}

/** The label after a run of exactly seven `char`s, '' for none; null when the line is no such marker. */
function marker(line: string, char: string): string | null {
  const run = char.repeat(7)
  if (!line.startsWith(run) || line[7] === char) return null
  if (line.length === 7) return ''
  return line[7] === ' ' ? line.slice(8).trimEnd() : null
}
