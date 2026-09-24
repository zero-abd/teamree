import { describe, expect, it } from 'vitest'
import { SLASH_GROUPS, SLASH_ITEMS, slashItems } from './slashCommands'

describe('slashItems', () => {
  it('offers every block with nothing typed, in the menu’s order', () => {
    expect(slashItems('').map((item) => item.id)).toEqual(SLASH_ITEMS.map((item) => item.id))
  })

  it('groups the rows, each group together and in the menu’s order', () => {
    expect(SLASH_GROUPS).toEqual(['Basic blocks', 'Lists', 'Media', 'Advanced'])
    const groups = SLASH_ITEMS.map((item) => item.group)
    expect([...new Set(groups)]).toEqual(SLASH_GROUPS)
    expect(groups).toEqual([...groups].sort((a, b) => SLASH_GROUPS.indexOf(a) - SLASH_GROUPS.indexOf(b)))
  })

  it('falls back to letters in order when nothing starts with what was typed', () => {
    expect(slashItems('bltd').map((item) => item.id)).toEqual(['bullets'])
    expect(slashItems('hd2').map((item) => item.id)).toEqual(['heading2'])
    expect(slashItems('cllt').map((item) => item.id)).toEqual(['callout'])
  })

  it('narrows by label first, then by keyword', () => {
    expect(slashItems('head').map((item) => item.id)).toEqual(['heading1', 'heading2', 'heading3'])
    expect(slashItems('h2').map((item) => item.id)).toEqual(['heading2'])
    expect(slashItems('ul').map((item) => item.id)).toEqual(['bullets'])
    expect(slashItems('nothing here')).toEqual([])
  })

  it('turns `artifact <url>` into one card row for a claude.ai address, and nothing for any other', () => {
    const [card] = slashItems('artifact https://claude.ai/code/artifacts/abc')
    expect(card).toMatchObject({ id: 'artifact', detail: 'abc', argument: 'https://claude.ai/code/artifacts/abc' })
    expect(slashItems('artifact https://example.com/x')).toEqual([])
    expect(slashItems('artifact').map((item) => item.id)).toEqual(['artifact'])
  })

  it('turns `image <path>` into one row carrying the path', () => {
    expect(slashItems('image docs/shot.png')[0]).toMatchObject({ id: 'image', argument: 'docs/shot.png' })
  })
})
