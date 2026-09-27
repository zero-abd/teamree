import { describe, expect, it } from 'vitest'
import { foldChips, foldTitle, type RowChip } from './rowChips'

const chip = (key: string, rank: RowChip['rank'] = 'rest'): RowChip => ({ key, rank, text: `${key} text`, node: key })

describe('foldChips', () => {
  it('shows what needs you first: asking, then a conflict, then failing checks, then the rest as given', () => {
    const { shown, folded } = foldChips(
      [
        chip('port'),
        chip('pr', 'failing'),
        chip('overlap', 'conflict'),
        chip('handoff'),
        chip('tally', 'asking'),
        chip('claims')
      ],
      6
    )
    expect(shown.map((entry) => entry.key)).toEqual(['tally', 'overlap', 'pr', 'port', 'handoff', 'claims'])
    expect(folded).toEqual([])
  })

  it('folds everything past the room into one +N, lowest rank last', () => {
    const { shown, folded } = foldChips(
      [chip('git'), chip('pr', 'failing'), chip('port'), chip('overlap', 'conflict'), chip('handoff')],
      2
    )
    expect(shown.map((entry) => entry.key)).toEqual(['overlap', 'pr'])
    expect(folded.map((entry) => entry.key)).toEqual(['git', 'port', 'handoff'])
  })

  it('folds them all when there is no room at all', () => {
    const { shown, folded } = foldChips([chip('a'), chip('b')], 0)
    expect(shown).toEqual([])
    expect(folded.map((entry) => entry.key)).toEqual(['a', 'b'])
  })
})

describe('foldTitle', () => {
  it('lists each folded chip on its own line', () => {
    expect(foldTitle([chip('git'), chip('port')])).toBe('git text\nport text')
  })
})
