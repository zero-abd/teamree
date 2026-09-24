// markdown-it reads the file (CommonMark, GFM tables, strikethrough, task lists)
// and prosemirror-markdown writes it back; raw HTML is kept verbatim both ways.

import { getSchema, type JSONContent } from '@tiptap/core'
import MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState, type ParseSpec } from 'prosemirror-markdown'
import { isArtifactUrl } from './artifactUrl'
import { markdownExtensions } from './markdownExtensions'

const TASK_MARKER = /^\[( |x|X)\](?:[ \t]|$)/

/** Items opening `[ ]` or `[x]` are task items; a bullet list of nothing else is a task list. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index]
    if (open === undefined || (open.type !== 'bullet_list_open' && open.type !== 'ordered_list_open')) continue
    const close = matchingClose(tokens, index)
    if (close === -1) continue
    let allTasks = true
    for (let at = index + 1; at < close; at += 1) {
      const token = tokens[at]
      if (token === undefined || token.type !== 'list_item_open' || token.level !== open.level + 1) continue
      const inline = tokens[at + 2]
      const marker = tokens[at + 1]?.type === 'paragraph_open' && inline?.type === 'inline' ? inline : undefined
      const match = marker === undefined ? null : TASK_MARKER.exec(marker.content)
      if (marker === undefined || match === null) {
        allTasks = false
        continue
      }
      const end = tokens[matchingClose(tokens, at)]
      token.type = 'task_item_open'
      token.attrSet('checked', match[1] === ' ' ? 'false' : 'true')
      if (end !== undefined) end.type = 'task_item_close'
      marker.content = marker.content.replace(TASK_MARKER, '')
    }
    const last = tokens[close]
    if (allTasks && open.type === 'bullet_list_open' && last !== undefined) {
      open.type = 'task_list_open'
      last.type = 'task_list_close'
    }
  }
}

/** The index of the close token pairing the open at `index`, or -1. */
function matchingClose(tokens: readonly Token[], index: number): number {
  const open = tokens[index]
  if (open === undefined) return -1
  const wanted = open.type.replace(/_open$/, '_close')
  for (let at = index + 1; at < tokens.length; at += 1) {
    const token = tokens[at]
    if (token !== undefined && token.type === wanted && token.level === open.level) return at
  }
  return -1
}

const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i

/** A quote whose first line is only `[!KIND]` is a GitHub alert; the marker line leaves the paragraph. */
function callouts(state: StateCore): void {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index]
    const paragraph = tokens[index + 1]
    const inline = tokens[index + 2]
    if (open?.type !== 'blockquote_open' || paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
    const match = CALLOUT_MARKER.exec(inline.content)
    const close = tokens[matchingClose(tokens, index)]
    if (match === null || close === undefined) continue
    open.type = 'callout_open'
    open.attrSet('kind', (match[1] ?? 'note').toLowerCase())
    close.type = 'callout_close'
    inline.content = inline.content.slice(match[0].length)
    if (inline.content.length === 0) tokens.splice(index + 1, 3)
    else if (paragraph.map !== null) paragraph.map = [paragraph.map[0] + 1, paragraph.map[1]]
  }
}

/** A table cell holds a paragraph in the schema; markdown-it puts the line straight in. */
function tableCells(state: StateCore): void {
  const out: Token[] = []
  for (const token of state.tokens) {
    if (token.type === 'th_close' || token.type === 'td_close') {
      const close = new state.Token('paragraph_close', 'p', -1)
      close.hidden = true
      out.push(close)
    }
    out.push(token)
    if (token.type === 'th_open' || token.type === 'td_open') {
      const open = new state.Token('paragraph_open', 'p', 1)
      open.hidden = true
      out.push(open)
    }
  }
  state.tokens = out
}

/** A paragraph that is one link to claude.ai is an artifact card. */
function artifactCards(state: StateCore): void {
  const tokens = state.tokens
  const out: Token[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index]
    const inline = tokens[index + 1]
    const close = tokens[index + 2]
    const children = inline?.children ?? []
    const [first, text, last] = children
    const href = first?.type === 'link_open' ? first.attrGet('href') : null
    if (
      open?.type === 'paragraph_open' &&
      inline?.type === 'inline' &&
      close?.type === 'paragraph_close' &&
      children.length === 3 &&
      text?.type === 'text' &&
      last?.type === 'link_close' &&
      href !== null &&
      isArtifactUrl(href)
    ) {
      const card = new state.Token('artifact_card', '', 0)
      card.attrSet('url', href)
      card.attrSet('title', text.content)
      card.level = open.level
      card.map = open.map
      card.block = true
      out.push(card)
      index += 2
      continue
    }
    if (open !== undefined) out.push(open)
  }
  state.tokens = out
}

function createTokenizer(): MarkdownIt {
  const md = new MarkdownIt('default', { html: true, linkify: false, typographer: false })
  md.core.ruler.after('block', 'teamree_task_lists', taskLists)
  md.core.ruler.after('block', 'teamree_table_cells', tableCells)
  md.core.ruler.after('block', 'teamree_callouts', callouts)
  md.core.ruler.after('inline', 'teamree_artifact_cards', artifactCards)
  return md
}

/** A block the tokenizer read: the node it becomes and the source lines it came from. */
export type BlockToken = { name: string; map: [number, number] | null; children: BlockToken[] }

function blockTree(tokens: readonly Token[]): BlockToken[] {
  const root: BlockToken = { name: 'doc', map: null, children: [] }
  const stack = [root]
  for (const token of tokens) {
    if (!token.block || token.type === 'inline') continue
    const base = token.type.replace(/_(open|close)$/, '')
    const spec = TOKENS[base]
    if (spec === undefined || spec.ignore === true) continue
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const node: BlockToken = {
      name: spec.block ?? spec.node ?? base,
      map: token.map === null ? null : [token.map[0], token.map[1]],
      children: []
    }
    stack[stack.length - 1]?.children.push(node)
    if (token.nesting === 1) stack.push(node)
  }
  return root.children
}

const TOKENS: Record<string, ParseSpec> = {
  paragraph: { block: 'paragraph' },
  heading: { block: 'heading', getAttrs: (token) => ({ level: Number(token.tag.slice(1)) || 1 }) },
  blockquote: { block: 'blockquote' },
  callout: { block: 'callout', getAttrs: (token) => ({ kind: token.attrGet('kind') ?? 'note' }) },
  bullet_list: { block: 'bulletList' },
  ordered_list: { block: 'orderedList', getAttrs: (token) => ({ start: Number(token.attrGet('start')) || 1 }) },
  list_item: { block: 'listItem' },
  task_list: { block: 'taskList' },
  task_item: { block: 'taskItem', getAttrs: (token) => ({ checked: token.attrGet('checked') === 'true' }) },
  code_block: { block: 'codeBlock', noCloseToken: true, attrs: { language: null } },
  fence: {
    block: 'codeBlock',
    noCloseToken: true,
    getAttrs: (token) => ({ language: token.info.trim().split(/\s+/)[0] || null })
  },
  hr: { node: 'horizontalRule' },
  image: {
    node: 'image',
    getAttrs: (token) => ({
      src: token.attrGet('src'),
      alt: token.children?.[0]?.content || null,
      title: token.attrGet('title') || null
    })
  },
  hardbreak: { node: 'hardBreak' },
  html_block: { node: 'htmlBlock', getAttrs: (token) => ({ html: token.content.replace(/\n$/, '') }) },
  html_inline: { node: 'htmlInline', getAttrs: (token) => ({ html: token.content }) },
  artifact_card: {
    node: 'artifactCard',
    getAttrs: (token) => ({ url: token.attrGet('url') ?? '', title: token.attrGet('title') ?? '' })
  },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader' },
  td: { block: 'tableCell' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: { mark: 'link', getAttrs: (token) => ({ href: token.attrGet('href'), title: token.attrGet('title') || null }) },
  code_inline: { mark: 'code', noCloseToken: true }
}

type NodeWriter = (state: MarkdownSerializerState, node: ProseNode, parent: ProseNode, index: number) => void

/** The state's fields its typings mark internal; `renderList` below is a copy of its own. */
type SerializerInternals = {
  inTightList: boolean
  inAutolink: boolean | undefined
  flushClose: (size?: number) => void
}

const internals = (state: MarkdownSerializerState): SerializerInternals => state as unknown as SerializerInternals

/** Whether a list is written with no blank line between its items. */
function isTight(list: ProseNode): boolean {
  let tight = true
  list.forEach((item) => {
    item.forEach((child, _, index) => {
      if (index > 0 && !child.type.name.endsWith('List')) tight = false
    })
  })
  return tight
}

/** `MarkdownSerializerState.renderList`, reading tightness off the items rather than an attribute. */
function renderList(
  state: MarkdownSerializerState,
  node: ProseNode,
  delim: string,
  firstDelim: (index: number) => string
): void {
  const inner = internals(state)
  if (inner.inTightList) inner.flushClose(1)
  const tight = isTight(node)
  const wasTight = inner.inTightList
  inner.inTightList = tight
  node.forEach((child, _, index) => {
    if (index > 0 && tight) inner.flushClose(1)
    state.wrapBlock(delim, firstDelim(index), node, () => state.render(child, node, index))
  })
  inner.inTightList = wasTight
}

const BULLETS = { kinds: ['bulletList', 'taskList'], markers: ['-', '*'] }
const ORDERED = { kinds: ['orderedList'], markers: ['.', ')'] }

/** Alternates the marker between adjacent lists, which CommonMark would otherwise read as one. */
function listMarker(parent: ProseNode, index: number, family: { kinds: string[]; markers: string[] }): string {
  let run = 0
  while (index - run - 1 >= 0 && family.kinds.includes(parent.child(index - run - 1).type.name)) run += 1
  return family.markers[run % 2] ?? '-'
}

/** The box a task item writes after its list marker. */
function box(list: ProseNode, at: number): string {
  const item = list.child(at)
  if (item.type.name !== 'taskItem') return ''
  return item.attrs.checked ? '[x] ' : '[ ] '
}

/** Escapes a backslash that would escape what follows, and what a line start would misread. */
function lightEsc(text: string, startOfLine = false): string {
  const out = text.replace(/\\(?=[!-/:-@[-`{-~]|$)/g, '\\\\')
  if (!startOfLine) return out
  return out
    .replace(/^([-*+])(?=[ \t]|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*\d+)([.)])(\s|$)/, '$1\\$2$3')
}

function fenceFor(text: string): string {
  const runs = text.match(/`{3,}/g)
  return runs ? `${runs.sort().slice(-1)[0]}\`` : '```'
}

const NODES: Record<string, NodeWriter> = {
  paragraph(state, node) {
    state.renderInline(node)
    state.closeBlock(node)
  },
  heading(state, node) {
    state.write(`${'#'.repeat(Number(node.attrs.level) || 1)} `)
    state.renderInline(node, false)
    state.closeBlock(node)
  },
  blockquote(state, node) {
    state.wrapBlock('> ', null, node, () => state.renderContent(node))
  },
  callout(state, node) {
    state.wrapBlock('> ', null, node, () => {
      state.write(`[!${String(node.attrs.kind).toUpperCase()}]`)
      state.ensureNewLine()
      state.renderContent(node)
    })
  },
  codeBlock(state, node) {
    const fence = fenceFor(node.textContent)
    state.write(`${fence}${node.attrs.language ? String(node.attrs.language) : ''}\n`)
    state.text(node.textContent, false)
    state.write('\n')
    state.write(fence)
    state.closeBlock(node)
  },
  horizontalRule(state, node) {
    state.write('---')
    state.closeBlock(node)
  },
  bulletList(state, node, parent, index) {
    const bullet = listMarker(parent, index, BULLETS)
    renderList(state, node, '  ', (at) => `${bullet} ${box(node, at)}`)
  },
  orderedList(state, node, parent, index) {
    const start = Number(node.attrs.start) || 1
    const width = String(start + node.childCount - 1).length
    const delimiter = listMarker(parent, index, ORDERED)
    renderList(state, node, ' '.repeat(width + 2), (at) => {
      const number = String(start + at)
      return `${' '.repeat(width - number.length)}${number}${delimiter} ${box(node, at)}`
    })
  },
  listItem(state, node) {
    state.renderContent(node)
  },
  taskList(state, node, parent, index) {
    const bullet = listMarker(parent, index, BULLETS)
    renderList(state, node, '  ', (at) => `${bullet} ${box(node, at)}`)
  },
  taskItem(state, node) {
    state.renderContent(node)
  },
  image(state, node) {
    const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''
    state.write(
      `![${state.esc(String(node.attrs.alt ?? ''))}](${String(node.attrs.src ?? '').replace(/[()]/g, '\\$&')}${title})`
    )
  },
  hardBreak(state, node, parent, index) {
    for (let at = index + 1; at < parent.childCount; at += 1) {
      if (parent.child(at).type !== node.type) {
        state.write('\\\n')
        return
      }
    }
  },
  text(state, node) {
    state.text(node.text ?? '', !internals(state).inAutolink)
  },
  htmlBlock(state, node) {
    state.text(String(node.attrs.html), false)
    state.closeBlock(node)
  },
  htmlInline(state, node) {
    state.text(String(node.attrs.html), false)
  },
  artifactCard(state, node) {
    state.write(`[${state.esc(String(node.attrs.title))}](${String(node.attrs.url).replace(/[()]/g, '\\$&')})`)
    state.closeBlock(node)
  },
  table(state, node) {
    const rows: string[][] = []
    node.forEach((row) => {
      const cells: string[] = []
      row.forEach((cell) => cells.push(cellText(state, cell)))
      rows.push(cells)
    })
    const width = Math.max(1, ...rows.map((cells) => cells.length))
    const padded = rows.map((cells) => [...cells, ...Array<string>(width - cells.length).fill('')])
    const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
    const [header = Array<string>(width).fill(''), ...body] = padded
    const lines = [line(header), line(Array<string>(width).fill('---')), ...body.map(line)]
    state.text(lines.join('\n'), false)
    state.closeBlock(node)
  }
}

/** The state the serializer builds, whose constructor and output its typings keep internal. */
type OpenState = MarkdownSerializerState & { out: string }

function newState(): OpenState {
  const State = MarkdownSerializerState as unknown as new (
    nodes: typeof NODES,
    marks: typeof MARKS,
    options: typeof OPTIONS
  ) => OpenState
  return new State(NODES, MARKS, OPTIONS)
}

/** A cell's blocks on one line, pipes escaped: the same writer, run on the cell alone. */
function cellText(state: MarkdownSerializerState, cell: ProseNode): string {
  const inner = newState()
  inner.esc = state.esc
  inner.renderContent(schema.node('doc', null, cell.content))
  return inner.out
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function backticksFor(node: ProseNode, side: number): string {
  let length = 0
  if (node.isText) for (const run of (node.text ?? '').match(/`+/g) ?? []) length = Math.max(length, run.length)
  let result = length > 0 && side > 0 ? ' `' : '`'
  result += '`'.repeat(length)
  if (length > 0 && side < 0) result += ' '
  return result
}

function isPlainUrl(href: string, parent: ProseNode, index: number, mark: ProseNode['marks'][number]): boolean {
  if (!/^\w+:/.test(href)) return false
  const content = parent.child(index)
  if (!content.isText || content.text !== href || content.marks[content.marks.length - 1] !== mark) return false
  return index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks)
}

const MARKS: ConstructorParameters<typeof MarkdownSerializer>[1] = {
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: {
    open: (_state, _mark, parent, index) => backticksFor(parent.child(index), -1),
    close: (_state, _mark, parent, index) => backticksFor(parent.child(index - 1), 1),
    escape: false
  },
  link: {
    open(state, mark, parent, index) {
      internals(state).inAutolink = isPlainUrl(String(mark.attrs.href ?? ''), parent, index, mark)
      return internals(state).inAutolink ? '<' : '['
    },
    close(state, mark) {
      const autolink = internals(state).inAutolink
      internals(state).inAutolink = undefined
      if (autolink) return '>'
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : ''
      return `](${String(mark.attrs.href ?? '').replace(/[()"]/g, '\\$&')}${title})`
    },
    mixable: true
  }
}

const schema = getSchema(markdownExtensions())
const tokenizer = createTokenizer()
// The parser tokenizes on its own; this keeps its tokens for the line map.
let lastTokens: Token[] = []
const recording = { parse: (text: string, env: object) => (lastTokens = tokenizer.parse(text, env)) }
const parser = new MarkdownParser(schema, recording as unknown as MarkdownIt, TOKENS)
const OPTIONS = { hardBreakNodeName: 'hardBreak' }
const serializer = new MarkdownSerializer(NODES, MARKS, OPTIONS)

export const markdownSchema = schema

export type References = Record<string, unknown>

/** The document for this text, its blocks' source lines, and the link definitions it holds. */
export function readMarkdownTree(
  text: string,
  references?: References
): { doc: ProseNode; blocks: BlockToken[]; references: References } {
  const env: { references?: References } = references === undefined ? {} : { references: { ...references } }
  const doc = parser.parse(text, env)
  return { doc, blocks: blockTree(lastTokens), references: env.references ?? {} }
}

/** These blocks as markdown, escaping only at line starts when `light`, else wherever markdown could. */
export function writeBlocks(nodes: readonly ProseNode[], light: boolean): string {
  const state = newState()
  if (light) state.esc = lightEsc
  state.renderContent(schema.node('doc', null, [...nodes]))
  return state.out.replace(/\s+$/, '')
}

/** Text escaped as `writeBlocks` would escape it. */
export function escapeText(text: string, light: boolean, startOfLine: boolean): string {
  return light ? lightEsc(text, startOfLine) : newState().esc(text, startOfLine)
}

/** The file for this document, ending in one newline. */
export function serializeMarkdown(content: JSONContent): string {
  const doc = schema.nodeFromJSON(content)
  const out = serializer.serialize(doc).replace(/\s+$/, '')
  return out.length === 0 ? '' : `${out}\n`
}
