// Teammates' comments on this machine's tasks, as the window holds them. Re-read on the `teammates` event.

import { create } from 'zustand'
import type { ReceivedReview } from '@shared/teammateReview'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'

/** How many popups are on screen at once; the rest wait their turn, oldest first. */
export const MAX_REVIEW_POPUPS = 3

type ReceivedReviewsState = {
  reviews: ReceivedReview[]
  refresh: () => Promise<void>
  /** `seen` retires the popup; `closed` forgets the review. */
  settle: (id: string, how: 'seen' | 'closed') => Promise<void>
}

/** The popups asking now: unseen reviews, oldest first. */
export function reviewPopups(reviews: readonly ReceivedReview[]): ReceivedReview[] {
  return reviews
    .filter((review) => !review.seen)
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(0, MAX_REVIEW_POPUPS)
}

export const useReceivedReviews = create<ReceivedReviewsState>()((set) => ({
  reviews: [],

  async refresh() {
    const reviews = await runtimeClient.call('teamwork.reviews', {}).catch(() => null)
    if (reviews) set({ reviews })
  },

  async settle(id, how) {
    set((state) => ({
      reviews:
        how === 'closed'
          ? state.reviews.filter((review) => review.id !== id)
          : state.reviews.map((review) => (review.id === id ? { ...review, seen: true } : review))
    }))
    await runtimeClient.call('teamwork.settleReview', { id, how }).catch(() => undefined)
  }
}))
