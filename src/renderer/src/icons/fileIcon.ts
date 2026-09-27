// Which glyph a file row draws, from its name alone: a few neutral kinds, never a brand's mark.

import type { IconName } from './Icon'

const KINDS: [IconName, string][] = [
  [
    'file-code',
    'ts tsx js jsx mjs cjs mts cts py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish lua sql vue svelte css scss less html htm'
  ],
  ['file-text', 'md mdx markdown txt rst adoc'],
  ['file-data', 'json jsonc json5 yaml yml toml lock xml csv tsv ini env conf cfg plist'],
  ['file-image', 'png jpg jpeg gif webp svg ico bmp avif heic tif tiff']
]
const BY_EXTENSION = new Map(
  KINDS.flatMap(([icon, extensions]) => extensions.split(' ').map((extension) => [extension, icon] as const))
)

const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'changelog', 'authors', 'notice'])

export function fileIconFor(name: string): IconName {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return TEXT_NAMES.has(lower) ? 'file-text' : 'file'
  // `.gitignore`, `.npmrc`: a dotfile with no other dot is configuration.
  if (dot === 0) return 'file-data'
  return BY_EXTENSION.get(lower.slice(dot + 1)) ?? 'file'
}
