// Just enough colour on a line of a patch: a tokenizer, not a parser, one
// line at a time with no knowledge of the line above (a hunk starts wherever
// git decided), so a multi-line `/* …` colours only its first line. An
// extension not in the table gets no colour rather than a guess.

export type SyntaxKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment'

export type SyntaxToken = {
  kind: SyntaxKind
  text: string
}

/** The languages there is a table for. Everything else is left alone. */
export type SyntaxLanguage = 'ts' | 'js' | 'json' | 'css' | 'md' | 'sh' | 'py'

const BY_EXTENSION: Record<string, SyntaxLanguage> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  md: 'md',
  markdown: 'md',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  py: 'py'
}

/**
 * Which table to colour a file's lines with, from its name alone: the name is
 * all a patch carries, and guessing from content colours prose as Python.
 */
export function syntaxLanguage(path: string): SyntaxLanguage | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

type Spec = {
  lineComment: readonly string[]
  block: readonly [string, string] | null
  quotes: readonly string[]
  keywords: ReadonlySet<string>
}

const JS_WORDS = [
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield'
]

const TS_WORDS = [
  ...JS_WORDS,
  'abstract',
  'any',
  'boolean',
  'declare',
  'enum',
  'implements',
  'interface',
  'keyof',
  'namespace',
  'never',
  'number',
  'private',
  'protected',
  'public',
  'readonly',
  'satisfies',
  'string',
  'type',
  'unknown'
]

const SH_WORDS = [
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'export',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'return',
  'then',
  'until',
  'while'
]

const PY_WORDS = [
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield'
]

const SPECS: Record<Exclude<SyntaxLanguage, 'md'>, Spec> = {
  ts: { lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], keywords: new Set(TS_WORDS) },
  js: { lineComment: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], keywords: new Set(JS_WORDS) },
  // JSON has no comments and three bare words; a key is a string.
  json: { lineComment: [], block: null, quotes: ['"'], keywords: new Set(['true', 'false', 'null']) },
  // `#` in CSS starts a colour, not a comment.
  css: { lineComment: [], block: ['/*', '*/'], quotes: ['"', "'"], keywords: new Set(['important', 'from', 'to']) },
  sh: { lineComment: ['#'], block: null, quotes: ['"', "'"], keywords: new Set(SH_WORDS) },
  py: { lineComment: ['#'], block: null, quotes: ['"', "'"], keywords: new Set(PY_WORDS) }
}

/** One line, split into runs the panel can paint; plain runs are merged, so a dull line is one span. */
export function tokenizeLine(text: string, language: SyntaxLanguage | null): SyntaxToken[] {
  if (text === '') return []
  if (language === null) return [{ kind: 'plain', text }]
  if (language === 'md') return tokenizeMarkdown(text)

  const spec = SPECS[language]
  const tokens: SyntaxToken[] = []
  let plain = ''
  const add = (kind: SyntaxKind, run: string): void => {
    if (run === '') return
    if (kind === 'plain') {
      plain += run
      return
    }
    if (plain !== '') {
      tokens.push({ kind: 'plain', text: plain })
      plain = ''
    }
    tokens.push({ kind, text: run })
  }

  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    const opener = spec.lineComment.find((prefix) => rest.startsWith(prefix))
    if (opener !== undefined) {
      add('comment', rest)
      break
    }

    if (spec.block !== null && rest.startsWith(spec.block[0])) {
      const closed = text.indexOf(spec.block[1], at + spec.block[0].length)
      // Unclosed on this line: the rest is a comment and the lines below are on their own.
      const stop = closed === -1 ? text.length : closed + spec.block[1].length
      add('comment', text.slice(at, stop))
      at = stop
      continue
    }

    const character = text[at] ?? ''
    if (spec.quotes.includes(character)) {
      const stop = endOfString(text, at, character)
      add('string', text.slice(at, stop))
      at = stop
      continue
    }

    // A digit inside a word (`utf8`, a CSS class) is part of the word.
    if (isDigit(character) && !isWord(text[at - 1] ?? '')) {
      let stop = at
      while (stop < text.length && isNumber(text[stop] ?? '')) stop += 1
      add('number', text.slice(at, stop))
      at = stop
      continue
    }

    if (isWord(character) && !isDigit(character)) {
      let stop = at
      while (stop < text.length && isWord(text[stop] ?? '')) stop += 1
      const word = text.slice(at, stop)
      add(spec.keywords.has(word) ? 'keyword' : 'plain', word)
      at = stop
      continue
    }

    add('plain', character)
    at += 1
  }

  if (plain !== '') tokens.push({ kind: 'plain', text: plain })
  return tokens
}

/**
 * Markdown: a heading and a span of code, nothing else. Emphasis is left alone
 * because a patch is full of underscores that are not emphasis.
 */
function tokenizeMarkdown(text: string): SyntaxToken[] {
  const heading = /^\s*#{1,6}\s/.exec(text)
  if (heading !== null) return [{ kind: 'keyword', text }]

  const tokens: SyntaxToken[] = []
  let plain = ''
  let at = 0
  while (at < text.length) {
    if (text[at] === '`') {
      const closed = text.indexOf('`', at + 1)
      const stop = closed === -1 ? text.length : closed + 1
      if (plain !== '') {
        tokens.push({ kind: 'plain', text: plain })
        plain = ''
      }
      tokens.push({ kind: 'string', text: text.slice(at, stop) })
      at = stop
      continue
    }
    plain += text[at]
    at += 1
  }
  if (plain !== '') tokens.push({ kind: 'plain', text: plain })
  return tokens
}

/** Past the closing quote, or to the end of the line when there is not one. */
function endOfString(text: string, at: number, quote: string): number {
  let stop = at + 1
  while (stop < text.length) {
    if (text[stop] === '\\') {
      stop += 2
      continue
    }
    if (text[stop] === quote) return stop + 1
    stop += 1
  }
  return text.length
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

function isWord(character: string): boolean {
  return /[\w$]/.test(character)
}

/** The tail of a number: digits, a radix, a decimal point, a CSS unit. */
function isNumber(character: string): boolean {
  return /[\w.%]/.test(character)
}
