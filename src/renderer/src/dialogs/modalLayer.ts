// What, if anything, is on top of the window.
//
// Two different things render into the modal layer and the store holds them in
// two different places, for a reason that is about who raised them rather than
// about how they look. `dialog` is whatever this window's own user opened, one
// at a time, closed by the next thing they open. `consent` is a question
// another machine raised: it is not this user's action, it must not be cleared
// by whatever they were in the middle of, and it arrives on somebody else's
// schedule — which means it can land on top of a dialog that is already up.
//
// Everything that has to stand aside from "something modal is on screen" needs
// both halves of that answer: the window's key handler, and the two cards that
// speak without being asked. Each of them was written knowing about one half,
// because each was written before the other half existed, and a card drawn
// under a scrim or a chord that fires behind a modal is what that costs. So the
// answer lives here once instead of being restated with a piece missing.

import type { ConsentRequest } from '@shared/entities'

/** As much of the store as either question below actually reads. */
type ModalLayerState = {
  dialog: unknown | null
  consent: Readonly<Record<string, { requests: ConsentRequest[] }>>
}

/**
 * The one question to put on screen, out of everything waiting.
 *
 * Oldest first and one at a time. Several teammates typing at several panes is
 * several questions, and stacking them would be a wall of dialogs nobody reads
 * — which is the failure mode this whole feature has to avoid, because a prompt
 * people click through is worse than no prompt at all. Answering one reveals
 * the next.
 */
export function firstQuestion(
  byProject: Readonly<Record<string, { requests: ConsentRequest[] }>>
): ConsentRequest | null {
  let oldest: ConsentRequest | null = null
  for (const answer of Object.values(byProject)) {
    for (const request of answer.requests) {
      if (oldest === null || request.since < oldest.since) oldest = request
    }
  }
  return oldest
}

/**
 * True while anything is holding the window: a dialog, or a question about a
 * teammate's keystrokes.
 *
 * The keystroke question counts even though nobody in this window opened it —
 * especially because nobody in this window opened it. It is the one modal here
 * that refuses Escape, so anything that went on acting underneath it would be
 * acting where the person cannot see and cannot undo.
 */
export function modalOnScreen(state: ModalLayerState): boolean {
  return state.dialog !== null || firstQuestion(state.consent) !== null
}
