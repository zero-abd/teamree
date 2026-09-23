// Recovers the output node-pty's socket leaves behind on teardown. On POSIX the
// master fd's `tty.ReadStream` can report end-of-stream while bytes still sit
// in the kernel buffer, and node-pty then closes the fd (its `close` handling,
// or the 200ms timer after the child is reaped). This wraps the socket's
// `destroy` and reads the fd to its real end first. POSIX only: ConPTY output
// arrives over a named pipe.

import { readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { IDisposable, IPty } from 'node-pty'

const READ_CHUNK_BYTES = 64 * 1024

/** A ceiling on one drain, so a grandchild still writing cannot hold teardown. */
const DRAIN_CAP_BYTES = 16 * 1024 * 1024

/** The parts of node-pty's Unix handle this needs; absent on Windows. */
type UnixPtyInternals = {
  _fd?: unknown
  _socket?: { destroy?: unknown }
}

const inert: IDisposable = { dispose: () => {} }

/**
 * Arranges for `onChunk` to receive what is still readable when node-pty closes
 * the pty. Inert on Windows and on any handle that does not look as expected.
 */
export function recoverTailOnTeardown(
  handle: IPty,
  platform: NodeJS.Platform,
  onChunk: (chunk: string) => void
): IDisposable {
  if (platform === 'win32') return inert

  const internals = handle as unknown as UnixPtyInternals
  const fd = internals._fd
  const socket = internals._socket
  if (typeof fd !== 'number' || socket === undefined) return inert

  const destroy = socket.destroy
  if (typeof destroy !== 'function') return inert

  let drained = false
  socket.destroy = function (this: unknown, ...args: unknown[]): unknown {
    if (!drained) {
      drained = true
      try {
        readToEnd(fd, onChunk)
      } catch {
        // Closing the pty is not optional: node-pty reports the exit off this call.
      }
    }
    return (destroy as (...rest: unknown[]) => unknown).apply(this, args)
  }

  return {
    dispose: () => {
      socket.destroy = destroy
    }
  }
}

/**
 * Reads the fd until the kernel has nothing more. The fd is non-blocking, so
 * EIO (pty finished) and EAGAIN (nothing now, and no later instant) both stop it.
 */
function readToEnd(fd: number, onChunk: (chunk: string) => void): void {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  let taken = 0

  while (taken < DRAIN_CAP_BYTES) {
    let read: number
    try {
      read = readSync(fd, buffer, 0, buffer.length, null)
    } catch {
      break
    }
    if (read === 0) break
    taken += read
    const text = decoder.write(buffer.subarray(0, read))
    if (text.length > 0) onChunk(text)
  }

  // A character split between the socket's last read and this one is marked, not dropped.
  const rest = decoder.end()
  if (rest.length > 0) onChunk(rest)
}
