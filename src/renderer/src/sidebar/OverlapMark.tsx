// The overlap chip: `⚠ auth.ts` or `⚠ 3 files`, red when a merge would conflict.

import type { OverlapChip, OverlapEntry } from './overlapChip'

/** Sits inside a row's button, so a click stops here rather than opening the row too. */
export function OverlapMark({
  chip,
  onOpen
}: {
  chip: OverlapChip
  onOpen?: (entry: OverlapEntry) => void
}): React.JSX.Element {
  const first = chip.entries[0]
  return (
    <span
      className={`chip overlap overlap--${chip.tone}${onOpen === undefined ? '' : ' overlap--open'}`}
      title={chip.title}
      aria-label={`${chip.tone === 'conflict' ? 'Conflicts' : 'Overlaps'}: ${chip.label}`}
      onClick={
        onOpen === undefined || first === undefined
          ? undefined
          : (event) => {
              event.stopPropagation()
              onOpen(first)
            }
      }
    >
      <span className="overlap__glyph" aria-hidden="true">
        ⚠
      </span>
      {chip.label}
    </span>
  )
}
