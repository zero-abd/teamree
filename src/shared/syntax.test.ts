// The colour on a line of a patch, which is only worth having if it is right.
//
// A few lines per language, chosen for the thing each language gets wrong: the
// `#` that is a comment in a shell and a colour in CSS, the digits inside a
// word that are not a number, the apostrophe in prose that is not a string, and
// the extension nobody has a table for — which has to come back with no colour
// rather than a guess, because a wrongly highlighted keyword in somebody's Rust
// reads as the renderer knowing something it does not.

import { describe, expect, it } from 'vitest'
import { syntaxLanguage, tokenizeLine, type SyntaxKind } from './syntax'

/** What the line looks like once painted: one entry per run, in order. */
function painted(text: string, path: string): [SyntaxKind, string][] {
  return tokenizeLine(text, syntaxLanguage(path)).map((token) => [token.kind, token.text])
}

describe('syntaxLanguage', () => {
  it('reads the table off the extension', () => {
    expect(syntaxLanguage('src/renderer/App.tsx')).toBe('ts')
    expect(syntaxLanguage('scripts/smoke.mjs')).toBe('js')
    expect(syntaxLanguage('package.json')).toBe('json')
    expect(syntaxLanguage('src/styles/tokens.css')).toBe('css')
    expect(syntaxLanguage('README.md')).toBe('md')
    expect(syntaxLanguage('bin/release.sh')).toBe('sh')
    expect(syntaxLanguage('tools/build.py')).toBe('py')
  })

  // The honest fallback, and the reason there is one.
  it('has no table for anything else, including a file with no extension', () => {
    expect(syntaxLanguage('src/main.rs')).toBeNull()
    expect(syntaxLanguage('Makefile')).toBeNull()
    expect(syntaxLanguage('.gitignore')).toBeNull()
  })
})

describe('tokenizeLine', () => {
  it('leaves a line alone when there is no table for it', () => {
    expect(painted('fn main() { let x = 1; }', 'src/main.rs')).toEqual([['plain', 'fn main() { let x = 1; }']])
  })

  it('has nothing to paint on an empty line', () => {
    expect(tokenizeLine('', 'ts')).toEqual([])
  })

  describe('typescript', () => {
    it('picks out keywords, strings and numbers', () => {
      expect(painted("const width = 'wide' + 12", 'a.ts')).toEqual([
        ['keyword', 'const'],
        ['plain', ' width = '],
        ['string', "'wide'"],
        ['plain', ' + '],
        ['number', '12']
      ])
    })

    it('reads a line comment to the end of the line, keywords and all', () => {
      expect(painted('let x = 1 // return false', 'a.ts')).toEqual([
        ['keyword', 'let'],
        ['plain', ' x = '],
        ['number', '1'],
        ['plain', ' '],
        ['comment', '// return false']
      ])
    })

    // A block comment that closes on its own line is the ordinary case.
    it('closes a block comment where it closes', () => {
      expect(painted('const a = /* why */ 2', 'a.ts')).toEqual([
        ['keyword', 'const'],
        ['plain', ' a = '],
        ['comment', '/* why */'],
        ['plain', ' '],
        ['number', '2']
      ])
    })

    // A digit inside a word is not a number, which is what a naive scan for
    // digits turns every `utf8` and `h2` into.
    it('does not find a number inside a word', () => {
      expect(painted('const utf8 = 1', 'a.ts')).toEqual([
        ['keyword', 'const'],
        ['plain', ' utf8 = '],
        ['number', '1']
      ])
    })
  })

  describe('json', () => {
    it('colours keys as strings and the three bare words as keywords', () => {
      expect(painted('  "private": true,', 'package.json')).toEqual([
        ['plain', '  '],
        ['string', '"private"'],
        ['plain', ': '],
        ['keyword', 'true'],
        ['plain', ',']
      ])
    })
  })

  describe('css', () => {
    // The one that catches a shared comment table: `#` opens a colour here.
    it('does not read a hex colour as a comment', () => {
      expect(painted('  --bg-window: #000000;', 'tokens.css')).toEqual([
        ['plain', '  --bg-window: #'],
        ['number', '000000'],
        ['plain', ';']
      ])
    })

    it('reads its block comments', () => {
      expect(painted('/* one palette */', 'tokens.css')).toEqual([['comment', '/* one palette */']])
    })
  })

  describe('markdown', () => {
    it('marks a heading and a code span, and leaves the prose alone', () => {
      expect(painted('## What it does', 'README.md')).toEqual([['keyword', '## What it does']])
      expect(painted('Run `npm test` first.', 'README.md')).toEqual([
        ['plain', 'Run '],
        ['string', '`npm test`'],
        ['plain', ' first.']
      ])
    })

    // Prose is full of apostrophes and underscores, and a language table would
    // turn half a sentence into a string at the first one.
    it('does not start a string at an apostrophe in a sentence', () => {
      expect(painted("It doesn't open a string.", 'README.md')).toEqual([['plain', "It doesn't open a string."]])
    })
  })

  describe('shell', () => {
    it('reads # as a comment and quotes as strings', () => {
      expect(painted('cp "$one" ../two # keep it', 'run.sh')).toEqual([
        ['plain', 'cp '],
        ['string', '"$one"'],
        ['plain', ' ../two '],
        ['comment', '# keep it']
      ])
    })

    it('knows the words that are not commands', () => {
      expect(painted('if [ -f x ]; then', 'run.sh')).toEqual([
        ['keyword', 'if'],
        ['plain', ' [ -f x ]; '],
        ['keyword', 'then']
      ])
    })
  })

  describe('python', () => {
    it('picks out a definition, a string and a number', () => {
      expect(painted("def run(name = 'x', size = 3):", 'build.py')).toEqual([
        ['keyword', 'def'],
        ['plain', ' run(name = '],
        ['string', "'x'"],
        ['plain', ', size = '],
        ['number', '3'],
        ['plain', '):']
      ])
    })
  })
})
