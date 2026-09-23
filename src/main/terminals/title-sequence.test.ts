import { describe, expect, it } from 'vitest'
import { TitleSequenceScanner } from './title-sequence'

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** Most of these are about titles alone; this keeps them reading that way. */
function titlesIn(scanner: TitleSequenceScanner, chunk: string): string[] {
  return scanner.scan(chunk).titles
}

describe('TitleSequenceScanner', () => {
  it('reads an OSC 0 title terminated by BEL', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]0;claude — src${BEL}$ `)).toEqual(['claude — src'])
  })

  it('reads an OSC 2 title terminated by ST', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]2;window title${ESC}\\`)).toEqual(['window title'])
  })

  it('accepts the single-byte C1 string terminator', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]0;c1 form${ST_C1}`)).toEqual(['c1 form'])
  })

  it('carries an unfinished sequence across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `before${ESC}]0;split-ti`)).toEqual([])
    expect(titlesIn(scanner, `tle${BEL}after`)).toEqual(['split-title'])
  })

  it('carries a two-byte ST split across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]2;st-split${ESC}`)).toEqual([])
    expect(titlesIn(scanner, '\\rest of output')).toEqual(['st-split'])
  })

  it('carries the introducer itself across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `output${ESC}`)).toEqual([])
    expect(titlesIn(scanner, ']0;late')).toEqual([])
    expect(titlesIn(scanner, BEL)).toEqual(['late'])
  })

  it('survives being fed one character at a time', () => {
    const scanner = new TitleSequenceScanner()
    const stream = `ls${ESC}]0;agent@worktree${BEL}done${ESC}]2;second${ESC}\\`
    const titles = [...stream].flatMap((char) => titlesIn(scanner, char))
    expect(titles).toEqual(['agent@worktree', 'second'])
  })

  it('ignores OSC codes that are not titles', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]1;icon only${BEL}`)).toEqual([])
    expect(titlesIn(scanner, `${ESC}]8;;https://example.com${BEL}`)).toEqual([])
    expect(titlesIn(scanner, `${ESC}]133;A${BEL}`)).toEqual([])
  })

  it('ignores CSI sequences and plain text', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}[31mred${ESC}[0m plain ]0;not a title${BEL}`)).toEqual([])
  })

  it('reports an empty title, which is how a program clears it', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]0;${BEL}`)).toEqual([''])
  })

  it('abandons a runaway payload and still reads the next title', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]0;${'x'.repeat(9000)}`)).toEqual([])
    expect(titlesIn(scanner, `${BEL}${ESC}]0;recovered${BEL}`)).toEqual(['recovered'])
  })

  it('drops a payload interrupted by a non-ST escape', () => {
    const scanner = new TitleSequenceScanner()
    expect(titlesIn(scanner, `${ESC}]0;interrupted${ESC}[0m${BEL}`)).toEqual([])
  })

  it('resets cleanly mid-sequence', () => {
    const scanner = new TitleSequenceScanner()
    scanner.scan(`${ESC}]0;half`)
    scanner.reset()
    expect(titlesIn(scanner, `way${BEL}`)).toEqual([])
  })
})

// The distinction the rest of the app cannot make for itself: a BEL that closes
// an OSC is punctuation, and an agent repainting a spinner into its title emits
// one of those several times a second.
describe('TitleSequenceScanner bells', () => {
  it('counts a bell a program rang on its own', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`done${BEL}`)).toEqual({ titles: [], bells: 1 })
  })

  it('does not count the BEL that terminates a title', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;\u25d0 working${BEL}`)).toEqual({ titles: ['\u25d0 working'], bells: 0 })
  })

  it('does not count the BEL that terminates an OSC which is not a title', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]8;;https://example.com${BEL}`)).toEqual({ titles: [], bells: 0 })
  })

  it('counts a bell rung between two titles, and neither terminator', () => {
    const scanner = new TitleSequenceScanner()
    const stream = `${ESC}]0;first${BEL}${BEL}${ESC}]0;second${BEL}`
    expect(scanner.scan(stream)).toEqual({ titles: ['first', 'second'], bells: 1 })
  })

  it('counts a bell split from its neighbours by a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;title`)).toEqual({ titles: [], bells: 0 })
    expect(scanner.scan(BEL)).toEqual({ titles: ['title'], bells: 0 })
    expect(scanner.scan(BEL)).toEqual({ titles: [], bells: 1 })
  })
})
