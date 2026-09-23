// One `ps` call, read into rows.
//
// `ps -axo pid,ppid,pcpu,rss,comm` is the one sample: every process on the
// machine, its parent, its share of a core and its resident size, in one
// spawn. Everything that reads per pane reads this table, because a process
// spawned per pid per sample is a fan on a laptop with forty panes open.
//
// `comm` is the last column on purpose. On macOS it is the executable's full
// path and that path has spaces in it — `teamree Helper (Renderer)` — so the
// four numbers are read from the front and whatever is left is the command.

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
    // The header, a blank line, or a line that is not a row: none of them is
    // a process, and a table with none of them is an empty answer rather than
    // a broken one.
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
