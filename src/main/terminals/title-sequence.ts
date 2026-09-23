// Extracts window titles, and bells, from a PTY output stream.
//
// A title arrives as OSC 0 (icon + window) or OSC 2 (window): ESC ] Ps ; text
// terminated by BEL or by ST (ESC \, or the single-byte C1 form). The stream is
// chopped into arbitrary chunks by the kernel and by node-pty, so a sequence can
// straddle any number of reads -- including the two bytes of ESC \ landing in
// different chunks. The scanner therefore keeps state between calls and never
// treats a chunk as a self-contained string.
//
// Bells are counted here for the same reason titles are parsed here: this is
// the only thing in the app that knows which BEL bytes are bells. Most of them
// are not -- a BEL that closes an OSC is punctuation, and a title-setting
// program emits one per title. Counted anywhere else, a pane that updates a
// spinner in its title would look like a pane ringing the bell ten times a
// second.

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** Titles are short; anything longer is a runaway sequence and is abandoned, so a
 *  process that never terminates an OSC cannot grow this buffer without bound. */
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
          // Outside a sequence a BEL is what it says it is: a program asking to
          // be noticed. Inside one it is punctuation, handled below.
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
      // 0 sets icon and window title, 2 sets the window title. 1 is icon-only,
      // and higher codes (8 hyperlinks, 133 prompt marks, ...) are not titles.
      if (ps === '0' || ps === '2') titles.push(this.payload.slice(separator + 1))
    }
    this.abandon()
  }

  private abandon(): void {
    this.state = 'text'
    this.payload = ''
  }
}
