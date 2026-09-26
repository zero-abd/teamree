// Repo-relative path globs for advisory claims: `*` and `?` stay in one segment,
// `**` spans any, and a bare directory claims everything under it.

const cache = new Map<string, RegExp>()

export function normalizeGlob(glob: string): string {
  return glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
}

function compile(glob: string): RegExp {
  const normalized = normalizeGlob(glob).replace(/\/+$/, '')
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string
    if (character === '*' && normalized[index + 1] === '*') {
      const slash = normalized[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}(?:/.*)?$`)
}

export function matchesGlob(path: string, glob: string): boolean {
  let pattern = cache.get(glob)
  if (pattern === undefined) {
    pattern = compile(glob)
    if (cache.size > 2000) cache.clear()
    cache.set(glob, pattern)
  }
  return pattern.test(path)
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob))
}
