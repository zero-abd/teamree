// A location as compilers and agents print it: `path:line`, `path:line:col` or `path(line,col)`.

export type LineQuery = { path: string; line?: number; column?: number }

const SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)):?$/

/** The path to match and the place to open at; a colon still waiting for its number is dropped. */
export function lineQuery(query: string): LineQuery {
  const typed = query.trim()
  const found = SUFFIX.exec(typed)
  if (found === null) return { path: typed.replace(/:$/, '') }
  const path = found[1] ?? ''
  const line = Number(found[2] ?? found[4])
  if (line < 1) return { path }
  const column = Number(found[3] ?? found[5])
  return column >= 1 ? { path, line, column } : { path, line }
}
