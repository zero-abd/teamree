import type { BaseFetchFailure } from './entities'

/** A failed fetch of `baseRef` in a few words: `can't reach origin`, `sign-in failed`. */
export function fetchFailureWords(failure: BaseFetchFailure, baseRef: string): string {
  const slash = baseRef.indexOf('/')
  const remote = slash > 0 ? baseRef.slice(0, slash) : 'origin'
  switch (failure) {
    case 'offline':
      return `can't reach ${remote}`
    case 'auth':
      return 'sign-in failed'
    case 'not-found':
      return `${baseRef} not found`
    case 'timeout':
      return 'fetch timed out'
    case 'failed':
      return 'fetch failed'
  }
}
