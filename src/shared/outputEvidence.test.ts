import { describe, expect, it } from 'vitest'
import { EVIDENCE_MAX_CHARS, evidenceLine, replayLines } from './outputEvidence'

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

describe('replayLines', () => {
  it('splits plain output into lines', () => {
    expect(replayLines('one\ntwo\n')).toEqual(['one', 'two', ''])
  })

  it('collapses a carriage-return progress line to its final state', () => {
    expect(replayLines('\r 10%\r 55%\r100%')).toEqual(['100%'])
  })

  it('leaves the tail of a longer line behind when the rewrite is shorter', () => {
    // Exactly what a terminal shows: nothing erased the characters further right.
    expect(replayLines('downloading 100%\rdone')).toEqual(['doneloading 100%'])
  })

  it('honours erase-to-end-of-line, which is how a spinner clears itself', () => {
    expect(replayLines(`installing packages\r${ESC}[Kinstalled`)).toEqual(['installed'])
  })

  it('honours erase-whole-line', () => {
    expect(replayLines(`old text${ESC}[2K\rnew text`)).toEqual(['new text'])
  })

  it('honours erase-to-start-of-line', () => {
    expect(replayLines(`abcdef\r${ESC}[3C${ESC}[1K`)).toEqual(['   def'])
  })

  it('applies backspaces the way a shell erases a typed character', () => {
    expect(replayLines('git stauts\b\b\b\b\btatus')).toEqual(['git status'])
  })

  it('drops SGR colour without eating the text it wraps', () => {
    expect(replayLines(`${ESC}[31mFAIL${ESC}[0m src/app.test.ts`)).toEqual(['FAIL src/app.test.ts'])
  })

  it('drops an OSC title terminated by BEL, by ST and by the C1 form', () => {
    expect(replayLines(`${ESC}]0;user@host: ~${BEL}ready`)).toEqual(['ready'])
    expect(replayLines(`${ESC}]2;title${ESC}\\ready`)).toEqual(['ready'])
    expect(replayLines(`${ESC}]2;title${ST_C1}ready`)).toEqual(['ready'])
  })

  it('drops a bell rather than turning it into a glyph', () => {
    expect(replayLines(`build failed${BEL}`)).toEqual(['build failed'])
  })

  it('survives a sequence cut in half by the tail slice', () => {
    expect(replayLines(`text${ESC}[3`)).toEqual(['text'])
    expect(replayLines(`text${ESC}]0;unfinis`)).toEqual(['text'])
  })

  it('writes past the end of a line that a carriage return left short', () => {
    expect(replayLines(`ab\r${ESC}[2K${ESC}[5Cxy`)).toEqual(['     xy'])
  })
})

describe('evidenceLine', () => {
  it('has nothing to show for empty output', () => {
    expect(evidenceLine('')).toBeNull()
    expect(evidenceLine('\n\n   \n')).toBeNull()
  })

  it('takes the last line that carries text, not the last line', () => {
    expect(evidenceLine('running tests\n\n\n')).toBe('running tests')
  })

  it('reads through a shell prompt to the output above it', () => {
    const output = `${ESC}[32mmain${ESC}[0m ❯ npm test\n41 files, 766 tests passed\nmain ❯ `
    expect(evidenceLine(output)).toBe('41 files, 766 tests passed')
  })

  it('refuses every common bare prompt', () => {
    for (const prompt of ['$ ', '% ', '# ', '❯ ', '➜  ', 'user@host:~/src$ ', '[root@host src]# ', '~/code % ']) {
      expect(evidenceLine(`\n${prompt}`)).toBeNull()
    }
  })

  it('keeps a prompt line once a command has been typed at it', () => {
    expect(evidenceLine('user@host:~/src$ npm run build')).toBe('user@host:~/src$ npm run build')
  })

  it('keeps a percentage, which ends in a prompt glyph but is not a prompt', () => {
    expect(evidenceLine('Downloading 45%')).toBe('Downloading 45%')
  })

  it('shows the settled state of a progress bar, not the fragment that ended it', () => {
    const output = '\rBuilding [=         ] 10%\rBuilding [=====     ] 50%\rBuilding [==========] 100%'
    expect(evidenceLine(output)).toBe('Building [==========] 100%')
  })

  it('drops the spinner frame from the line it decorates', () => {
    expect(evidenceLine(`${ESC}[2K\r⠹ Resolving dependencies`)).toBe('Resolving dependencies')
  })

  it('skips a line that is only a spinner frame', () => {
    expect(evidenceLine('compiling src/main.ts\n⠋')).toBe('compiling src/main.ts')
  })

  it('skips rules and box drawing, which say nothing on their own', () => {
    expect(evidenceLine('warning: 2 files changed\n────────────────\n')).toBe('warning: 2 files changed')
    expect(evidenceLine('done\n=========\n...')).toBe('done')
  })

  it('says nothing at all when every line is noise', () => {
    expect(evidenceLine(`${ESC}[2K\r⠋\n⠙\n⠹\n$ `)).toBeNull()
  })

  it('refuses to quote a full-screen program that owns the grid', () => {
    expect(evidenceLine(`${ESC}[?1049hsome pager row\n~\n~\n:`)).toBeNull()
  })

  it('reads normally again once the full-screen program has exited', () => {
    expect(evidenceLine(`${ESC}[?1049hpager${ESC}[?1049l\nback in the shell log`)).toBe('back in the shell log')
  })

  it('squeezes runs of whitespace so a column layout still reads as one line', () => {
    expect(evidenceLine('PASS\tsrc/app.test.ts   12ms')).toBe('PASS src/app.test.ts 12ms')
  })

  it('truncates a line too long to belong in a sidebar row', () => {
    const line = evidenceLine(`compiling ${'x'.repeat(400)}`)
    expect(line).toHaveLength(EVIDENCE_MAX_CHARS)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('takes the cap from its caller when the row is narrower', () => {
    expect(evidenceLine('installing dependencies', 12)).toBe('installing…')
  })

  it('gives up rather than scanning an unbounded backlog of blank lines', () => {
    expect(evidenceLine(`buried\n${'\n'.repeat(200)}`)).toBeNull()
  })

  it('reads a real vitest tail, spinner rewrites and all', () => {
    const output = [
      `${ESC}[?25l`,
      `${ESC}[2K\r ⠋ src/main/git/gitService.test.ts`,
      `${ESC}[2K\r ⠙ src/main/terminals/pty-session.test.ts`,
      `${ESC}[2K\r ${ESC}[32m✓${ESC}[0m src/main/terminals/pty-session.test.ts ${ESC}[90m(14 tests)${ESC}[0m\n`,
      ` Test Files  41 passed (41)\n`,
      `      Tests  766 passed (766)\n`,
      `${ESC}[?25h`
    ].join('')
    expect(evidenceLine(output)).toBe('Tests 766 passed (766)')
  })

  it('reads a real git tail with its error last', () => {
    const output = [
      'To github.com:teamree/teamree.git\n',
      ` ! [rejected]        main -> main (fetch first)\n`,
      `${ESC}[31merror: failed to push some refs${ESC}[0m\n`,
      'user@host:~/src$ '
    ].join('')
    expect(evidenceLine(output)).toBe('error: failed to push some refs')
  })
})

describe('evidenceLine, over the app’s own marks', () => {
  // Written into a restored pane around its record; a row quoting one reads like debris.
  it('walks past the record marks to the last real line', () => {
    const output = [
      `${ESC}[0m${ESC}[38;5;244m[record — up to 2026-09-23 11:40, nothing running]${ESC}[0m\r\n`,
      'server listening on :3000\r\n',
      `${ESC}[0m\r\n${ESC}[38;5;244m[end of record — new shell below]${ESC}[0m\r\n`,
      'user@host login-flow % '
    ].join('')
    expect(evidenceLine(output)).toBe('server listening on :3000')
  })

  it('shows nothing when a mark is all there is', () => {
    expect(evidenceLine('[end of record — new shell below]\r\n% ')).toBeNull()
    expect(evidenceLine('[no conversation to resume — fresh claude below]\r\n')).toBeNull()
    expect(evidenceLine('[resume refused — agent exited 1; open a new pane for a fresh one]\r\n')).toBeNull()
  })

  it('still quotes a program’s own bracketed line', () => {
    expect(evidenceLine('[build] 12 modules transformed')).toBe('[build] 12 modules transformed')
  })
})
