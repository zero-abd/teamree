// Output discipline: with --json, stdout carries exactly one JSON document and
// nothing else, so a caller can pipe it straight into a parser. Errors always
// go to stderr, in both modes.

import type { CliError } from './exit.js'

export type Streams = {
  out: (text: string) => void
  err: (text: string) => void
}

export type CommandOutput = {
  /** The machine-readable payload placed under `data` in --json mode. */
  data: unknown
  /** Human-readable rendering, without a trailing newline. */
  text: string
}

export function processStreams(): Streams {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text)
  }
}

export function emitSuccess(command: string, output: CommandOutput, json: boolean, streams: Streams): void {
  if (json) {
    streams.out(`${JSON.stringify({ ok: true, command, data: output.data })}\n`)
    return
  }
  if (output.text.length > 0) streams.out(output.text.endsWith('\n') ? output.text : `${output.text}\n`)
}

export function emitFailure(command: string, error: CliError, json: boolean, streams: Streams): void {
  if (json) {
    streams.err(`${JSON.stringify({ ok: false, command, error: error.serialize(), exitCode: error.exitCode })}\n`)
    return
  }
  streams.err(`error: ${error.message}\n`)
  if (error.hint) streams.err(`hint: ${error.hint}\n`)
}

/** Fixed-width columns; empty input renders as a single explanatory line. */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[], empty: string): string {
  if (rows.length === 0) return empty
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length)))
      .join('  ')
      .trimEnd()
  return [line(headers), ...rows.map((row) => line(row))].join('\n')
}

export function formatFields(pairs: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(0, ...pairs.map(([label]) => label.length))
  return pairs.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value}`).join('\n')
}
