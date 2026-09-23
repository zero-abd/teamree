// What, if anything, is on top of the window. `dialog` is this user's own, one at a time; `consent` is
// raised by another machine and can land over a dialog. Everything that stands aside needs both, so the
// answer lives here once.

import type { ConsentRequest } from '@shared/entities'

/** As much of the store as either question below actually reads. */
type ModalLayerState = {
  dialog: unknown | null
  consent: Readonly<Record<string, { requests: ConsentRequest[] }>>
}

/** The one question to show: oldest first, one at a time, so they are read rather than clicked through. */
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

/** True while a dialog or a remote-keystrokes question holds the window; the latter refuses Escape. */
export function modalOnScreen(state: ModalLayerState): boolean {
  return state.dialog !== null || firstQuestion(state.consent) !== null
}
