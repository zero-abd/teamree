// A token bucket per connection, refilled from the injected clock rather than a
// timer. No timer means no work for an idle connection, a limit that is a pure
// function of elapsed time is a limit a test can prove without sleeping, and a
// bucket that is two numbers is a bucket that survives being written to disk and
// read back — which is what a hibernating host needs.

export type BucketState = { tokens: number; lastRefill: number }

export type TokenBucket = {
  /** True if the cost fitted in the budget; false means the caller is over it. */
  take: (cost: number, now: number) => boolean
  state: () => BucketState
}

export function createTokenBucket(
  ratePerSecond: number,
  burst: number,
  now: number,
  restore?: BucketState
): TokenBucket {
  let tokens = restore?.tokens ?? burst
  let lastRefill = restore?.lastRefill ?? now

  return {
    take: (cost, at) => {
      // Clocks can step backwards; treat that as no elapsed time rather than as
      // a refund, so a clock adjustment cannot hand anyone free budget.
      const elapsed = Math.max(0, at - lastRefill)
      lastRefill = at
      tokens = Math.min(burst, tokens + (elapsed * ratePerSecond) / 1000)
      if (tokens < cost) return false
      tokens -= cost
      return true
    },
    state: () => ({ tokens, lastRefill })
  }
}
