// Bounded scrollback for one terminal, capped in bytes rather than lines (a
// progress bar's line can be enormous) and kept as bytes so a tail slice can
// repair a cut mid-character or mid-sequence.

/** Retained output per terminal. Roughly a few thousand dense lines. */
export const SCROLLBACK_CAP_BYTES = 4 * 1024 * 1024

/** Small writes are merged into the tail chunk, not millions of one-byte entries. */
const COALESCE_BELOW_BYTES = 8 * 1024

/** How far past a cut to look for where a sequence could start; a longer run is left as cut. */
const SEQUENCE_REPAIR_BYTES = 4096

export class ScrollbackBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private capBytes: number
  /** Whether eviction has cut the oldest retained output, so even a whole read starts at a cut. */
  private headCut = false

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
      this.headCut = true
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
    const tail = Buffer.concat(slice, want - remaining)
    return (want < this.bytes || this.headCut ? fromSequenceBoundary(tail) : tail).toString('utf8')
  }

  clear(): void {
    this.chunks = []
    this.bytes = 0
    this.headCut = false
  }

  /** Lowers the cap for the rest of this buffer's life, evicting down to it now. One-way. */
  restrictTo(capBytes: number): void {
    if (capBytes <= 0) throw new RangeError('scrollback cap must be positive')
    if (capBytes >= this.capBytes) return
    this.capBytes = capBytes
    this.evictOverflow()
  }

  private evictOverflow(): void {
    if (this.bytes > this.capBytes) this.headCut = true
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

/**
 * A cut output from where a sequence could start: at the next ESC, or past the next CR, LF or BEL.
 * A cut CSI's parameters would otherwise print as text; what is dropped is part of a line.
 */
function fromSequenceBoundary(buffer: Buffer): Buffer {
  const window = Math.min(buffer.byteLength, SEQUENCE_REPAIR_BYTES)
  for (let index = 0; index < window; index++) {
    const byte = buffer[index]
    if (byte === 0x1b) return buffer.subarray(index)
    if (byte === 0x0a || byte === 0x0d || byte === 0x07) return buffer.subarray(index + 1)
  }
  // No boundary near: drop only the UTF-8 continuation bytes a byte-aligned cut left dangling.
  let start = 0
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++
  return buffer.subarray(start)
}
