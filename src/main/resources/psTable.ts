// One `ps` call, read into rows: one spawn per sample, not one per pid. `comm`
// is last because on macOS it is a full path with spaces in it.

import type { ResourceProcess } from '../../shared/entities'

/** The arguments to `ps`, spelled out once so the parser and the sampler agree. */
export const PS_ARGS: readonly string[] = ['-axo', 'pid,ppid,pcpu,rss,comm']

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.*?)\s*$/

/** `ps` prints rss in kibibytes on both platforms this app runs on. */
const RSS_UNIT_BYTES = 1024

export function parsePsTable(text: string): ResourceProcess[] {
  const rows: ResourceProcess[] = []
  for (const line of text.split('\n')) {
    const match = ROW.exec(line)
    // The header, a blank line, or a line that is not a row.
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      rss: Number(match[4]) * RSS_UNIT_BYTES,
      command: basename(match[5] ?? '')
    })
  }
  return rows
}

function basename(command: string): string {
  const slash = command.lastIndexOf('/')
  return slash === -1 ? command : command.slice(slash + 1)
}
