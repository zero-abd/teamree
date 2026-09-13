// Recovers the output node-pty's socket leaves behind when a pty is torn down.
//
// On a POSIX pty the master fd is read through a `tty.ReadStream`, and that
// stream can stop early: when the child closes the slave, the read can report
// end-of-stream while bytes the child already wrote are still sitting in the
// kernel's buffer. node-pty then closes the fd — from its own `close` handling,
// or from the 200ms timer it arms when the child is reaped — and those bytes are
// gone. It is the tail of a chatty command that goes, which is exactly the part
// an agent was waiting for.
//
// The fd itself still has the data right up until it is closed, so the last
// moment it can be saved is immediately before the close. That is what this
// does: it wraps the socket's `destroy` and reads the fd to its real end first.
// The read is a plain loop rather than another stream because it has to finish
// inside that one call, before the fd goes away.
//
// POSIX only. Windows has no such fd — ConPTY output arrives over a named pipe
// that node-pty owns — so there the behaviour is left exactly as it was.

import { readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { IDisposable, IPty } from 'node-pty'

const READ_CHUNK_BYTES = 64 * 1024

/**
 * A ceiling on one drain, so teardown always terminates.
 *
 * Nothing should still be writing to a pty that is being closed, but a
 * grandchild that outlived its parent can be, and a shutdown must not wait on
 * a process that has no reason to stop. Far above any real command's tail.
 */
const DRAIN_CAP_BYTES = 16 * 1024 * 1024

/** The parts of node-pty's Unix handle this needs; absent on Windows. */
type UnixPtyInternals = {
  _fd?: unknown
  _socket?: { destroy?: unknown }
}

const inert: IDisposable = { dispose: () => {} }

/**
 * Arranges for `onChunk` to receive whatever is still readable on the pty when
 * node-pty closes it, until the returned disposable gives the handle back as it
 * was. Inert on Windows, and on any handle that does not look the way this
 * expects, so an unfamiliar node-pty is only ever as lossy as it already is.
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
        // Recovering the tail is a bonus; closing the pty is not optional, and
        // node-pty reports the exit off the back of this call.
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
 * Reads the fd until the kernel has nothing more to give.
 *
 * The fd is non-blocking — libuv put it that way to poll it — so a read that
 * finds nothing throws instead of waiting, and both endings are a reason to
 * stop: EIO is the pty itself being finished, EAGAIN is nothing readable at
 * this instant, and after the close there will be no later instant.
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

  // A character split across the last read the socket managed and the first
  // read here cannot be reassembled; ending the decoder marks it rather than
  // dropping the bytes that followed it.
  const rest = decoder.end()
  if (rest.length > 0) onChunk(rest)
}
