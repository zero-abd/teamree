// Bounded scrollback for one terminal.
//
// An agent CLI can print megabytes a second, so retention is capped in bytes
// rather than lines: line counts say nothing about memory, and a single line of
// a progress bar can be enormous. Bytes are kept, not decoded text, because the
// cap has to mean something predictable and because a tail slice must be able to
// repair a cut in the middle of a multi-byte character.

/** Retained output per terminal. Roughly a few thousand dense lines. */
export const SCROLLBACK_CAP_BYTES = 4 * 1024 * 1024

/** Small writes are merged into the tail chunk so a chatty process cannot turn
 *  the cap into millions of one-byte array entries. */
const COALESCE_BELOW_BYTES = 8 * 1024

export class ScrollbackBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private capBytes: number

  constructor(capBytes: number = SCROLLBACK_CAP_BYTES) {
    if (capBytes <= 0) throw new RangeError('scrollback cap must be positive')
    this.capBytes = capBytes
  }

  get byteLength(): number {
    return this.bytes
  }

  get capacity(): number {
    return this.capBytes
  }

  append(text: string): void {
    if (text.length === 0) return
    const incoming = Buffer.from(text, 'utf8')

    // A write larger than the whole buffer: only its tail can survive.
    if (incoming.byteLength >= this.capBytes) {
      this.chunks = [incoming.subarray(incoming.byteLength - this.capBytes)]
      this.bytes = this.capBytes
      return
    }

    const last = this.chunks[this.chunks.length - 1]
    if (last !== undefined && last.byteLength + incoming.byteLength <= COALESCE_BELOW_BYTES) {
      this.chunks[this.chunks.length - 1] = Buffer.concat([last, incoming])
    } else {
      this.chunks.push(incoming)
    }
    this.bytes += incoming.byteLength
    this.evictOverflow()
  }

  /** Trailing `tailBytes` of retained output; the whole buffer when omitted. */
  tail(tailBytes?: number): string {
    const want = Math.min(tailBytes ?? this.bytes, this.bytes)
    if (want <= 0) return ''

    const slice: Buffer[] = []
    let remaining = want
    for (let i = this.chunks.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = this.chunks[i]
      if (chunk === undefined) continue
      if (chunk.byteLength <= remaining) {
        slice.unshift(chunk)
        remaining -= chunk.byteLength
      } else {
        slice.unshift(chunk.subarray(chunk.byteLength - remaining))
        remaining = 0
      }
    }
    return decodeFromCharacterBoundary(Buffer.concat(slice, want - remaining))
  }

  clear(): void {
    this.chunks = []
    this.bytes = 0
  }

  /**
   * Lowers the cap for the rest of this buffer's life, evicting down to it now.
   * One-way: a buffer that has been told to keep less is never asked to keep
   * more, and a request for more than it already keeps is not one.
   */
  restrictTo(capBytes: number): void {
    if (capBytes <= 0) throw new RangeError('scrollback cap must be positive')
    if (capBytes >= this.capBytes) return
    this.capBytes = capBytes
    this.evictOverflow()
  }

  private evictOverflow(): void {
    while (this.bytes > this.capBytes) {
      const head = this.chunks[0]
      if (head === undefined) {
        this.bytes = 0
        return
      }
      const excess = this.bytes - this.capBytes
      if (head.byteLength <= excess) {
        this.chunks.shift()
        this.bytes -= head.byteLength
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
    }
  }
}

/** Drops UTF-8 continuation bytes left dangling by a byte-aligned cut, so a tail
 *  never opens with a replacement character. */
function decodeFromCharacterBoundary(buffer: Buffer): string {
  let start = 0
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}
