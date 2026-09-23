// Whatever was piped in.
//
// `readStdinToEnd` is what `--prompt -` means: a person's pipe, read whole.
// `readProcessStdin` is for the one command that is run by another program.
// An agent's hook hands the hook's JSON to the command on stdin and closes it.
// Everything here is bounded, because the reader is inside somebody else's
// turn: a stdin that is a terminal is not read at all, one that never closes
// is given up on, and one that will not stop is cut off. Nothing is thrown —
// the caller has to be able to carry on with nothing.

/** How long to wait for the writer to close its end before going on without it. */
const STDIN_WAIT_MS = 2000

/** More than any hook's JSON, and less than would be worth reading. */
const STDIN_CAP_BYTES = 64 * 1024

/** Reads this process's stdin, or answers with nothing when there is none to read. */
export function readProcessStdin(): Promise<string> {
  const input = process.stdin
  if (input.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.removeListener('data', onData)
      resolve(text)
    }
    const onData = (chunk: string | Buffer): void => {
      text += chunk.toString()
      if (text.length >= STDIN_CAP_BYTES) finish()
    }
    const timer = setTimeout(finish, STDIN_WAIT_MS)
    input.setEncoding('utf8')
    input.on('data', onData)
    input.once('end', finish)
    input.once('error', finish)
  })
}

/** stdin, read whole, however long it takes to close; what `--prompt -` means. */
export function readStdinToEnd(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}
