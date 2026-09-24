// A file is written back from the lines it was read from: a block the page left
// alone keeps its bytes, and only what changed is written anew.

import type { JSONContent } from '@tiptap/core'
import { Mark, type Node as ProseNode } from '@tiptap/pm/model'
import {
  escapeText,
  markdownSchema,
  readMarkdownTree,
  serializeMarkdown,
  writeBlocks,
  type BlockToken,
  type References
} from './markdownDocument'

/** A block as read: what it parsed to, and the lines [from, to) it came from. */
type Span = { key: string; name: string; from: number; to: number; children: Span[] | null }

export type MarkdownFile = {
  /** The document the editor starts from. */
  doc: JSONContent
  text: string
  lines: string[]
  eol: string
  keys: string[]
  /** Null when the tokens and the document did not line up; the file is then kept only whole. */
  spans: Span[] | null
  references: References
}

/** How a container lays out its children where the file has nothing to reuse. */
type Container = {
  /** What goes before a new child that follows another. */
  gap: (node: ProseNode) => string
  /** Whether children that were not neighbours in the file need a blank line between them. */
  loose: boolean
  fresh: (node: ProseNode, first: boolean) => string
  changed: (node: ProseNode, span: Span, first: boolean) => string
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
const MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/
const FENCE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/
// What markdown may write as something other than itself.
const SPECIAL = /[\\`*_[\]<>&!~|#]/

const keyOf = (node: ProseNode): string => JSON.stringify(node.toJSON())
const isBlank = (line: string): boolean => /^[ \t]*[\r\n]*$/.test(line)
const endsLine = (text: string): boolean => text.length === 0 || /[\r\n]$/.test(text)
const width = (text: string): number => text.replace(/\t/g, '    ').length

/** A node's children, less the empty paragraphs that write as nothing. */
function significant(node: ProseNode): ProseNode[] {
  const out: ProseNode[] = []
  node.forEach((child) => {
    if (child.type.name !== 'paragraph' || child.childCount > 0) out.push(child)
  })
  return out
}

function splitLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
}

function zip(parent: ProseNode, tokens: readonly BlockToken[], lines: readonly string[], end: number): Span[] | null {
  const spans: Span[] = []
  let at = 0
  for (let index = 0; index < parent.childCount; index += 1) {
    const node = parent.child(index)
    const token = tokens[at]
    const empty = node.type.name === 'paragraph' && node.childCount === 0
    if (token === undefined || token.name !== node.type.name) {
      // The parser fills an empty item with an empty paragraph the file never had.
      if (empty) continue
      return null
    }
    at += 1
    if (empty) continue
    if (token.map === null) return null
    const from = token.map[0]
    let to = Math.min(token.map[1], end)
    while (to > from + 1 && isBlank(lines[to - 1] ?? '')) to -= 1
    const children = LISTS.has(node.type.name) || node.type.name.endsWith('Item') || node.type.name === 'table'
    spans.push({
      key: keyOf(node),
      name: node.type.name,
      from,
      to,
      children: children ? zip(node, token.children, lines, to) : null
    })
  }
  return at === tokens.length ? spans : null
}

/** Reads a file, keeping the lines each block came from. */
export function readMarkdownFile(text: string): MarkdownFile {
  const { doc, blocks, references } = readMarkdownTree(text)
  const lines = splitLines(text)
  return {
    doc: doc.toJSON() as JSONContent,
    text,
    lines,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    keys: significant(doc).map(keyOf),
    spans: zip(doc, blocks, lines, lines.length),
    references
  }
}

/** The file for this document: `file`'s own bytes wherever the document still says what they said. */
export function writeMarkdownFile(content: JSONContent, file: MarkdownFile | null): string {
  if (file === null) return serializeMarkdown(content)
  const doc = markdownSchema.nodeFromJSON(content)
  const nodes = significant(doc)
  const keys = nodes.map(keyOf)
  if (sameKeys(keys, file.keys)) return file.text
  if (file.spans === null) return serializeMarkdown(content)
  const writer = new Writer(file)
  const granular = writer.finish(writer.children(nodes, file.spans, 0, file.lines.length, writer.top()))
  if (writer.readsAs(granular, keys)) return granular
  const whole = serializeMarkdown(content)
  return writer.readsAs(whole, keys) ? whole : granular
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/** For each key, the span it is unchanged from: common ends first, then a longest common subsequence. */
function align(keys: readonly string[], spans: readonly Span[]): (number | null)[] {
  const match: (number | null)[] = keys.map(() => null)
  let low = 0
  while (low < keys.length && low < spans.length && keys[low] === spans[low]?.key) {
    match[low] = low
    low += 1
  }
  let highKeys = keys.length
  let highSpans = spans.length
  while (highKeys > low && highSpans > low && keys[highKeys - 1] === spans[highSpans - 1]?.key) {
    highKeys -= 1
    highSpans -= 1
    match[highKeys] = highSpans
  }
  const rows = highKeys - low
  const cols = highSpans - low
  if (rows === 0 || cols === 0 || rows * cols > 4_000_000) return match
  const table = new Uint32Array((rows + 1) * (cols + 1))
  const cell = (row: number, col: number): number => table[row * (cols + 1) + col] ?? 0
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row * (cols + 1) + col] =
        keys[low + row] === spans[low + col]?.key
          ? cell(row + 1, col + 1) + 1
          : Math.max(cell(row + 1, col), cell(row, col + 1))
    }
  }
  let row = 0
  let col = 0
  while (row < rows && col < cols) {
    if (keys[low + row] === spans[low + col]?.key) {
      match[low + row] = low + col
      row += 1
      col += 1
    } else if (cell(row + 1, col) >= cell(row, col + 1)) row += 1
    else col += 1
  }
  return match
}

type Found = { span: number; exact: boolean } | null

/** Matches, plus each unmatched node paired with the unmatched span of its type in the same place. */
function pair(nodes: readonly ProseNode[], spans: readonly Span[]): Found[] {
  const found: Found[] = align(nodes.map(keyOf), spans).map((span) => (span === null ? null : { span, exact: true }))
  let previous = -1
  let index = 0
  while (index < nodes.length) {
    const here = found[index]
    if (here) {
      previous = here.span
      index += 1
      continue
    }
    let end = index
    while (end < nodes.length && !found[end]) end += 1
    const next = found[end]?.span ?? spans.length
    for (let step = 0; index + step < end && previous + 1 + step < next; step += 1) {
      if (nodes[index + step]?.type.name === spans[previous + 1 + step]?.name) {
        found[index + step] = { span: previous + 1 + step, exact: false }
      }
    }
    index = end
  }
  return found
}

/** Prefixes each non-blank line, the first with `first`, the rest with `rest`. */
function prefixLines(text: string, first: string, rest: string, eol: string): string {
  if (text.length === 0) return first.trimEnd().length > 0 ? `${first.trimEnd()}${eol}` : ''
  return splitLines(text)
    .map((line, index) => {
      const body = line.replace(/[\r\n]+$/, '')
      const prefix = index === 0 ? first : rest
      return `${body.length === 0 ? prefix.trimEnd() : prefix + body}${eol}`
    })
    .join('')
}

class Writer {
  private readonly lines: readonly string[]
  private readonly eol: string

  constructor(private readonly file: MarkdownFile) {
    this.lines = file.lines
    this.eol = file.eol
  }

  top(): Container {
    return {
      gap: () => this.eol,
      loose: true,
      fresh: (node) => this.fresh([node]),
      changed: (node, span) => this.changedBlock(node, span)
    }
  }

  /** Whether `text` reads back as blocks with exactly these keys. */
  readsAs(text: string, keys: readonly string[], references?: References): boolean {
    const { doc } = readMarkdownTree(text, references)
    return sameKeys(significant(doc).map(keyOf), keys)
  }

  /** The original file's ending: a file without a final newline gains none. */
  finish(text: string): string {
    if (this.file.text.length > 0 && !endsLine(this.file.text)) return text.replace(/(\r\n|\r|\n)$/, '')
    return text
  }

  private slice(from: number, to: number): string {
    return this.lines.slice(from, to).join('')
  }

  /** New blocks, lightly escaped when that reads back the same. */
  private fresh(nodes: readonly ProseNode[]): string {
    if (nodes.length === 0) return ''
    const light = writeBlocks(nodes, true)
    const keys = nodes.map(keyOf)
    const text = this.readsAs(light, keys, this.file.references) ? light : writeBlocks(nodes, false)
    return text.length === 0 ? '' : `${text.split('\n').join(this.eol)}${this.eol}`
  }

  /** `nodes` laid over `spans`, which sit in lines [from, to). */
  children(nodes: readonly ProseNode[], spans: readonly Span[], from: number, to: number, box: Container): string {
    const found = pair(nodes, spans)
    const gap = (index: number): string => {
      const start = index < 0 ? from : (spans[index]?.to ?? from)
      const end = index + 1 < spans.length ? (spans[index + 1]?.from ?? to) : to
      return this.slice(start, Math.max(start, end))
    }
    const holds = (piece: string): string =>
      splitLines(piece)
        .filter((line) => !isBlank(line))
        .join('')
    // The gaps from `next` up to the span `before`: the last as written, and of any
    // before it (around blocks since deleted) what they hold, such as link definitions.
    const gaps = (next: number, before: number, blank: boolean): string => {
      if (before <= next) return ''
      const earlier: string[] = []
      for (let index = next; index < before - 1; index += 1) earlier.push(gap(index))
      const last = gap(before - 1)
      let text = earlier.some((piece) => holds(piece).length > 0)
        ? `${earlier[0] ?? ''}${earlier.slice(1).map(holds).join('')}${last}`
        : last
      if (blank && !splitLines(text).some(isBlank)) text = `${this.eol}${text}`
      return text
    }
    let out = ''
    const append = (piece: string): void => {
      if (piece.length === 0) return
      if (!endsLine(out)) out += this.eol
      out += piece
    }
    let next = -1
    let anchored: number | null = null
    nodes.forEach((node, index) => {
      const here = found[index]
      const first = out.length === 0 && next === -1
      if (here && here.span >= next) {
        const neighbour = anchored !== null ? here.span === anchored + 1 : first && here.span === 0
        // Blocks gone from the top take the blank lines after them along.
        const lead =
          first && here.span > 0
            ? `${gap(-1)}${gaps(0, here.span, false).replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, '')}`
            : gaps(next, here.span, box.loose && !neighbour && !first)
        append(lead)
        const span = spans[here.span]
        if (span !== undefined) append(here.exact ? this.slice(span.from, span.to) : box.changed(node, span, first))
        next = here.span
        anchored = here.span
        return
      }
      if (first) {
        append(gaps(-1, 0, false))
        next = 0
        append(box.fresh(node, out.length === 0))
      } else {
        append(box.gap(node))
        append(box.fresh(node, false))
      }
      anchored = null
    })
    const tail = gaps(next, spans.length, false)
    append(holds(tail).length > 0 && box.loose && anchored !== spans.length - 1 ? gaps(next, spans.length, true) : tail)
    return out
  }

  /** A top-level block that changed: its parts reused where they can be, checked by reading it back. */
  private changedBlock(node: ProseNode, span: Span): string {
    let text: string | null = null
    if (LISTS.has(node.type.name) && span.children !== null) text = this.changedList(node, span)
    else if (node.type.name === 'table' && span.children !== null) text = this.changedTable(node, span)
    else if (node.type.name === 'codeBlock') text = this.changedCode(node, span)
    else if (node.isTextblock) return this.splice(node, span, 0) ?? this.fresh([node])
    if (text !== null && this.readsAs(text, [keyOf(node)], this.file.references)) return text
    return this.fresh([node])
  }

  /**
   * A text block where one run of text changed: the change made to the lines as
   * written, found by the plain text around it. `lead` is the first line's marker.
   */
  private splice(node: ProseNode, span: Span, lead: number): string | null {
    const old = markdownSchema.nodeFromJSON(JSON.parse(span.key) as JSONContent)
    const sameBlock = old.type === node.type && JSON.stringify(old.attrs) === JSON.stringify(node.attrs)
    if (!sameBlock || old.childCount !== node.childCount) return null
    let at = -1
    for (let index = 0; index < node.childCount; index += 1) {
      const was = old.child(index)
      const now = node.child(index)
      if (was.eq(now)) continue
      if (at !== -1 || !was.isText || !now.isText || !Mark.sameSet(was.marks, now.marks)) return null
      at = index
    }
    if (at === -1) return null
    const before = old.child(at).text ?? ''
    const after = node.child(at).text ?? ''
    let prefix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
    let suffix = 0
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const deleted = before.slice(prefix, before.length - suffix)
    const inserted = after.slice(prefix, after.length - suffix)
    if (SPECIAL.test(deleted)) return null
    const context = (text: string): string => text.split(SPECIAL)[0]?.slice(0, 24) ?? ''
    const leading = [...context([...before.slice(0, prefix)].reverse().join(''))].reverse().join('')
    const trailing = context(before.slice(before.length - suffix))
    if (leading.length + deleted.length + trailing.length === 0) return null
    const source = this.slice(span.from, span.to)
    const pattern = (text: string): string =>
      text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '(?: |[ \\t]*(?:\\r\\n|\\r|\\n)[ \\t]*)')
    const found = [
      ...source.slice(lead).matchAll(new RegExp(`(${pattern(leading)})(${pattern(deleted)})${pattern(trailing)}`, 'g'))
    ]
    const match = found[0]
    if (found.length !== 1 || match === undefined) return null
    const start = lead + match.index + (match[1]?.length ?? 0)
    const end = start + (match[2]?.length ?? 0)
    const head = source.slice(0, start)
    const lineStart = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r')) + 1
    const startOfLine = /^[ \t]*$/.test(head.slice(lineStart === 0 ? lead : lineStart))
    for (const light of [true, false]) {
      const text = `${source.slice(0, start)}${escapeText(inserted, light, startOfLine)}${source.slice(end)}`
      const bare = splitLines(text)
        .map((piece, index) => (index === 0 ? piece.slice(lead) : piece.replace(/^[ \t]+/, '')))
        .join('')
      if (this.readsAs(bare, [keyOf(node)], this.file.references)) return text
    }
    return null
  }

  private changedList(list: ProseNode, span: Span): string {
    const spans = span.children ?? []
    const loose = spans.some((item, index) => index > 0 && item.from > (spans[index - 1]?.to ?? item.from))
    const numbers = spans.map((item) => MARKER.exec(this.lines[item.from] ?? '')?.[2] ?? '')
    const sameNumber = numbers.every((number) => number === numbers[0])
    const items: ProseNode[] = []
    list.forEach((item) => items.push(item))
    return this.children(items, spans, span.from, span.to, {
      gap: () => (loose ? this.eol : ''),
      loose,
      fresh: (item) => this.freshItem(item, list, items.indexOf(item), spans[0], sameNumber),
      changed: (item, itemSpan) => this.changedItem(item, list, items.indexOf(item), itemSpan, loose, sameNumber)
    })
  }

  private freshItem(
    item: ProseNode,
    list: ProseNode,
    index: number,
    template: Span | undefined,
    sameNumber: boolean
  ): string {
    const found = MARKER.exec(template === undefined ? '' : (this.lines[template.from] ?? ''))
    const indent = found?.[1] ?? ''
    let bullet = found?.[2] ?? (list.type.name === 'orderedList' ? '1.' : '-')
    if (list.type.name === 'orderedList' && !sameNumber) {
      bullet = `${(Number(list.attrs.start) || 1) + index}${bullet.slice(-1)}`
    }
    const box = item.type.name === 'taskItem' ? (item.attrs.checked ? '[x] ' : '[ ] ') : ''
    const rest = ' '.repeat(width(`${indent}${bullet} `))
    return prefixLines(this.fresh(significant(item)), `${indent}${bullet} ${box}`, rest, this.eol)
  }

  private changedItem(
    item: ProseNode,
    list: ProseNode,
    index: number,
    span: Span,
    loose: boolean,
    sameNumber: boolean
  ): string {
    const line = this.lines[span.from] ?? ''
    const found = MARKER.exec(line)
    if (found === null || span.children === null) return this.freshItem(item, list, index, span, sameNumber)
    const [marker, indent = '', bullet = '', space = ''] = found
    const pad = space.length > 0 && width(space) <= 4 ? space : ' '
    const rest = ' '.repeat(width(`${indent}${bullet}${pad}`))
    const task = item.type.name === 'taskItem'
    const mark = item.attrs.checked ? 'x' : ' '
    const written = /^\[[ xX]\][ \t]*/.exec(line.slice(marker.length))?.[0] ?? ''
    let first = `${indent}${bullet}${pad}`
    if (task) first += written.length > 0 ? written.replace(/\[[ xX]\]/, `[${mark}]`) : `[${mark}] `
    if (!/[ \t]$/.test(first)) first += ' '
    const onMarkerLine = span.children[0]?.from === span.from
    const out = this.children(significant(item), span.children, span.from, span.to, {
      gap: (node) => (LISTS.has(node.type.name) && !loose ? '' : this.eol),
      loose,
      fresh: (child, isFirst) =>
        prefixLines(this.fresh([child]), isFirst && onMarkerLine ? first : rest, rest, this.eol),
      changed: (child, childSpan, isFirst) => {
        if (LISTS.has(child.type.name) && childSpan.children !== null) return this.changedList(child, childSpan)
        const lead = childSpan.from === span.from ? marker.length + written.length : 0
        const spliced = child.isTextblock ? this.splice(child, childSpan, lead) : null
        return spliced ?? prefixLines(this.fresh([child]), isFirst && onMarkerLine ? first : rest, rest, this.eol)
      }
    })
    if (!task) return out
    return out.replace(/^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)\[[ xX]\]/, `$1[${mark}]`)
  }

  /** Rows reused where unchanged; the delimiter row, with its alignment, kept while the width holds. */
  private changedTable(table: ProseNode, span: Span): string | null {
    const rows = span.children ?? []
    const header = rows[0]
    const head = table.firstChild
    if (header === undefined || head === null) return null
    const delimiter = this.lines[header.to] ?? ''
    if (!/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*[\r\n]*$/.test(delimiter)) return null
    const aligns = delimiter
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
    const count = head.childCount
    const delimiterLine =
      aligns.length === count
        ? delimiter
        : `| ${Array.from({ length: count }, (_, at) => aligns[at] ?? '---').join(' | ')} |${this.eol}`
    for (const light of [true, false]) {
      const row = (node: ProseNode): string => {
        const written = writeBlocks([markdownSchema.nodes.table!.create(null, [node])], light)
        return `${written.split('\n')[0] ?? ''}${this.eol}`
      }
      const line = (node: ProseNode, at: Span | undefined): string =>
        at !== undefined && keyOf(node) === at.key ? this.slice(at.from, at.to) : row(node)
      const body: ProseNode[] = []
      table.forEach((node, _, at) => {
        if (at > 0) body.push(node)
      })
      const found = align(body.map(keyOf), rows.slice(1))
      const text = [
        line(head, header),
        delimiterLine,
        ...body.map((node, at) => {
          const match = found[at]
          return line(node, match === null || match === undefined ? undefined : rows[match + 1])
        })
      ]
        .map((piece) => (endsLine(piece) ? piece : `${piece}${this.eol}`))
        .join('')
      if (this.readsAs(text, [keyOf(table)], this.file.references)) return text
    }
    return null
  }

  /** The fence lines as written, around the code as it is now. */
  private changedCode(code: ProseNode, span: Span): string | null {
    const open = this.lines[span.from] ?? ''
    const found = FENCE.exec(open)
    if (found === null) return null
    const [, indent = '', fence = '', info = ''] = found
    const content = code.textContent
    const closes = new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}[ \\t]*$`, 'm')
    if (closes.test(content)) return null
    const words = info
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
    const language = code.attrs.language ? String(code.attrs.language) : null
    let opening = open
    if ((words[0] ?? null) !== language) {
      opening = `${indent}${fence}${[language ?? '', ...words.slice(1)].join(' ').trim()}${this.eol}`
    }
    const last = this.lines[span.to - 1] ?? ''
    const closing =
      span.to - span.from >= 2 &&
      new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}[ \\t]*[\\r\\n]*$`).test(last)
        ? last
        : `${indent}${fence}`
    const body =
      content.length === 0
        ? ''
        : content
            .split('\n')
            .map((line) => `${line.length > 0 ? indent : ''}${line}${this.eol}`)
            .join('')
    return [opening, body, closing].map((piece) => (endsLine(piece) ? piece : `${piece}${this.eol}`)).join('')
  }
}
