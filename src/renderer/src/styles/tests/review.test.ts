// The review view's pins.

import { describe, expect, it } from 'vitest'
import { opacitiesOf } from './css'

describe('review.css', () => {
  // Most people never hover, so a control drawn only under the pointer is one they never find.
  it('draws a hunk’s + faintly at rest, not invisibly', () => {
    expect(opacitiesOf('review.css', '.patch__plus')).toEqual(['var(--control-rest)'])
  })
})
