import { describe, expect, it } from 'vitest'
import { TitleSequenceScanner } from './title-sequence'

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

describe('TitleSequenceScanner', () => {
  it('reads an OSC 0 title terminated by BEL', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;claude — src${BEL}$ `)).toEqual(['claude — src'])
  })

  it('reads an OSC 2 title terminated by ST', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]2;window title${ESC}\\`)).toEqual(['window title'])
  })

  it('accepts the single-byte C1 string terminator', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;c1 form${ST_C1}`)).toEqual(['c1 form'])
  })

  it('carries an unfinished sequence across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`before${ESC}]0;split-ti`)).toEqual([])
    expect(scanner.scan(`tle${BEL}after`)).toEqual(['split-title'])
  })

  it('carries a two-byte ST split across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]2;st-split${ESC}`)).toEqual([])
    expect(scanner.scan('\\rest of output')).toEqual(['st-split'])
  })

  it('carries the introducer itself across a chunk boundary', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`output${ESC}`)).toEqual([])
    expect(scanner.scan(']0;late')).toEqual([])
    expect(scanner.scan(BEL)).toEqual(['late'])
  })

  it('survives being fed one character at a time', () => {
    const scanner = new TitleSequenceScanner()
    const stream = `ls${ESC}]0;agent@worktree${BEL}done${ESC}]2;second${ESC}\\`
    const titles = [...stream].flatMap((char) => scanner.scan(char))
    expect(titles).toEqual(['agent@worktree', 'second'])
  })

  it('ignores OSC codes that are not titles', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]1;icon only${BEL}`)).toEqual([])
    expect(scanner.scan(`${ESC}]8;;https://example.com${BEL}`)).toEqual([])
    expect(scanner.scan(`${ESC}]133;A${BEL}`)).toEqual([])
  })

  it('ignores CSI sequences and plain text', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}[31mred${ESC}[0m plain ]0;not a title${BEL}`)).toEqual([])
  })

  it('reports an empty title, which is how a program clears it', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;${BEL}`)).toEqual([''])
  })

  it('abandons a runaway payload and still reads the next title', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;${'x'.repeat(9000)}`)).toEqual([])
    expect(scanner.scan(`${BEL}${ESC}]0;recovered${BEL}`)).toEqual(['recovered'])
  })

  it('drops a payload interrupted by a non-ST escape', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.scan(`${ESC}]0;interrupted${ESC}[0m${BEL}`)).toEqual([])
  })

  it('resets cleanly mid-sequence', () => {
    const scanner = new TitleSequenceScanner()
    scanner.scan(`${ESC}]0;half`)
    scanner.reset()
    expect(scanner.scan(`way${BEL}`)).toEqual([])
  })
})
