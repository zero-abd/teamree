import { describe, expect, it } from 'vitest'
import { plainText } from './plainText.js'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

describe('plain text from a terminal snapshot', () => {
  // The snapshot QA pasted, byte for byte: zsh's partial-line marker, the OSC
  // title it sets, the bracketed-paste brackets around what was typed, and the
  // backspace that fixed the typo. Read raw it is unusable; this is the whole
  // reason the flag exists.
  it('reads the zsh prompt, the title, the paste markers and a typo as what the screen showed', () => {
    const raw =
      `${ESC}[1m${ESC}[7m%${ESC}[27m${ESC}[1m${ESC}[0m` +
      `${' '.repeat(40)}\r \r` +
      `${ESC}]0;abd@mac: ~/repos/teamree${BEL}` +
      `~/repos/teamree % ${ESC}[?2004he\bexit${ESC}[?2004l\r\r\n` +
      `logout\r\n`

    expect(plainText(raw)).toBe('~/repos/teamree % exit\nlogout\n')
  })

  it('drops CSI colour and cursor-visibility sequences', () => {
    expect(plainText(`${ESC}[32mgreen${ESC}[0m${ESC}[?25l done${ESC}[?25h`)).toBe('green done')
  })

  it('drops an OSC title however it is terminated', () => {
    expect(plainText(`${ESC}]0;title${BEL}a`)).toBe('a')
    expect(plainText(`${ESC}]0;title${ST}b`)).toBe('b')
    expect(plainText(`${ESC}]2;title\u009cc`)).toBe('c')
  })

  it('drops bracketed-paste markers and keeps what was pasted', () => {
    expect(plainText(`${ESC}[200~npm test${ESC}[201~`)).toBe('npm test')
  })

  it('drops DCS, APC and single-shift sequences with their payloads', () => {
    expect(plainText(`${ESC}P+q544f${ST}ok`)).toBe('ok')
    expect(plainText(`${ESC}_Ga=T,f=100;payload${ST}ok`)).toBe('ok')
    expect(plainText(`${ESC}OPok`)).toBe('ok')
    expect(plainText(`\u009b31mred\u009f apc ${ST}x`)).toBe('redx')
  })

  it('drops a two-character escape and the bell', () => {
    expect(plainText(`${ESC}(Bplain${ESC}7${BEL}!`)).toBe('plain!')
  })

  it('honours backspace', () => {
    expect(plainText('e\bexit')).toBe('exit')
    expect(plainText('abc\b\bZ')).toBe('aZc')
  })

  it('takes the carriage return before a newline off the line', () => {
    expect(plainText('one\r\ntwo\r\n')).toBe('one\ntwo\n')
  })

  it('lets a carriage return rewrite the line, as a progress bar does', () => {
    expect(plainText('  0%\r 50%\r100%\n')).toBe('100%\n')
  })

  it('honours erase-line', () => {
    expect(plainText(`spinner\r${ESC}[2Kdone\n`)).toBe('done\n')
    expect(plainText(`long line\rshort${ESC}[K\n`)).toBe('short\n')
  })

  it('keeps tab stops rather than collapsing them', () => {
    expect(plainText('a\tb\n')).toBe('a       b\n')
  })

  it('leaves ordinary text alone', () => {
    expect(plainText('no escapes here\n')).toBe('no escapes here\n')
    expect(plainText('')).toBe('')
  })

  it('ends a sequence the snapshot cut in half rather than printing its tail', () => {
    expect(plainText(`done${ESC}[38;5;`)).toBe('done')
    expect(plainText(`done${ESC}]0;half a title`)).toBe('done')
  })
})
