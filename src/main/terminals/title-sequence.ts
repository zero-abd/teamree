// Extracts window titles (OSC 0/2, terminated by BEL or ST) and bells from a
// PTY stream. A sequence can straddle any number of chunks, so state is kept
// between calls. Bells are counted here because only this knows which BELs are punctuation.

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** Anything longer is a runaway OSC and is abandoned, so the buffer is bounded. */
const MAX_PAYLOAD_LENGTH = 4096

type ScannerState =
  | 'text'
  /** Saw ESC, waiting to see whether it opens an OSC. */
  | 'escape'
  /** Inside ESC ] ..., accumulating the payload. */
  | 'payload'
  /** Saw ESC inside a payload: one more character decides ST or garbage. */
  | 'payload-escape'

/** What one chunk contained: the titles it completed, and the bells it rang. */
export type ScannedSequences = { titles: string[]; bells: number }

export class TitleSequenceScanner {
  private state: ScannerState = 'text'
  private payload = ''

  /** Feeds one chunk of output; returns what it completed, titles in order. */
  scan(chunk: string): ScannedSequences {
    const titles: string[] = []
    let bells = 0

    for (const char of chunk) {
      switch (this.state) {
        case 'text':
          if (char === ESC) this.state = 'escape'
          // Outside a sequence a BEL is a bell; inside one it is punctuation.
          else if (char === BEL) bells++
          break

        case 'escape':
          if (char === ']') {
            this.state = 'payload'
            this.payload = ''
          } else if (char !== ESC) {
            // Some other escape sequence (CSI, charset select, ...): ignore it.
            this.state = 'text'
            if (char === BEL) bells++
          }
          break

        case 'payload':
          if (char === BEL || char === ST_C1) {
            this.emit(titles)
          } else if (char === ESC) {
            this.state = 'payload-escape'
          } else if (this.payload.length >= MAX_PAYLOAD_LENGTH) {
            this.abandon()
          } else {
            this.payload += char
          }
          break

        case 'payload-escape':
          if (char === '\\') {
            this.emit(titles)
          } else if (char === ESC) {
            // ESC ESC: the first was noise, treat the second as a fresh start.
            this.abandon()
            this.state = 'escape'
          } else {
            this.abandon()
          }
          break
      }
    }

    return { titles, bells }
  }

  reset(): void {
    this.state = 'text'
    this.payload = ''
  }

  private emit(titles: string[]): void {
    const separator = this.payload.indexOf(';')
    if (separator !== -1) {
      const ps = this.payload.slice(0, separator)
      // 0 and 2 set the window title; 1 is icon-only, higher codes are not titles.
      if (ps === '0' || ps === '2') titles.push(this.payload.slice(separator + 1))
    }
    this.abandon()
  }

  private abandon(): void {
    this.state = 'text'
    this.payload = ''
  }
}
