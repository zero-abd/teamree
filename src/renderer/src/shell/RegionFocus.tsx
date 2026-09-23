// Moves the keyboard between regions after the render that draws them: a sidebar shown by ⌘B is
// not there yet when the command runs, and a closing palette hands focus back to its opener first.

import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { focusedRegion, focusRegion, onRegionRequest, regionAfterToggle, regionOf, type Region } from './regions'

export function RegionFocus(): null {
  // An object, so asking for the same region twice still runs the effect.
  const [pending, setPending] = useState<{ region: Region } | null>(null)

  useEffect(() => {
    const stopRequests = onRegionRequest((region) => setPending({ region }))
    // Synchronous with the store's change, so the DOM still says whether the region leaving held the focus.
    const stopWatching = useWorkspaceStore.subscribe((next, previous) => {
      const region = regionAfterToggle(next, previous, focusedRegion())
      if (region !== null) setPending({ region })
    })
    return () => {
      stopRequests()
      stopWatching()
    }
  }, [])

  useEffect(() => {
    if (pending !== null && regionOf(document.activeElement) !== pending.region) focusRegion(pending.region)
  }, [pending])

  return null
}
